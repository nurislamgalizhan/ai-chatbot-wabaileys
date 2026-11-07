import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Ctx } from "../context.ts";
import { HttpError } from "../lib/errors.ts";
import { maskPhone } from "../lib/phone.ts";
import { audit } from "../security/audit.ts";
import { endAdminSession, endAllAdminSessions, requireAdmin } from "../security/sessions.ts";
import { accessView, endOfLocalDay, todayLocal } from "../services/access.ts";
import { checkView, keyHash, newAccessKey } from "../services/check.ts";
import { Sealer } from "../security/crypto.ts";
import { SYSTEM_SESSION } from "../wa/manager.ts";
import { idParam, parse, phoneField, RL_STRICT } from "./util.ts";

/**
 * The platform owner's API. Signing in happens through the ordinary
 * /login form (see adminLogin.ts) — there is no admin login endpoint here.
 * Every route needs a full two-factor admin session; without one it
 * answers 404, exactly like a route that does not exist.
 */
export function adminRoutes(app: FastifyInstance, ctx: Ctx) {
  const { db, cfg, wa, adminAuth, kb } = ctx;
  const secure = cfg.isProd;
  const adminPhone = adminAuth.phone;
  const guard = { preHandler: requireAdmin(db, () => adminAuth.fingerprint()) };
  const checkSealer = new Sealer(cfg.appSecret, "check-key-v1");

  /** Same date rules as AI access: from today, at most 5 years ahead. */
  const parseUntil = (until: string): number => {
    const ms = endOfLocalDay(until);
    if (!Number.isFinite(ms) || ms < endOfLocalDay(todayLocal())) {
      throw new HttpError(400, "validation", "Дата окончания не может быть в прошлом");
    }
    if (ms > Date.now() + 5 * 366 * 24 * 3600_000) throw new HttpError(400, "validation", "Максимальный срок — 5 лет");
    return ms;
  };

  /** Admin UI bootstrap. 404 for everyone else, like any unknown route. */
  app.get("/api/admin/me", guard, async () => ({ admin: true, phone: adminPhone }));

  app.post("/api/admin/logout", guard, async (req, reply) => {
    endAdminSession(db, req, reply, secure);
    return { ok: true };
  });

  app.post("/api/admin/logout-all", guard, async (req, reply) => {
    endAllAdminSessions(db);
    endAdminSession(db, req, reply, secure);
    audit(db, { actor: "admin", action: "admin_logout_all", result: "ok", ip: req.ip });
    return { ok: true };
  });

  /* ---------- overview & AI access ---------- */

  app.get("/api/admin/overview", guard, async () => {
    const users = db.all<{
      id: number;
      name: string;
      company: string;
      phone: string;
      created_at: number;
      ai_access_until: number | null;
      check_until: number | null;
      has_key: number;
      wa_status: string | null;
      wa_phone: string | null;
      chats: number;
      messages_30d: number;
    }>(
      `SELECT u.id, u.name, u.company, u.phone, u.created_at, u.ai_access_until,
              u.check_until, (u.check_token_hash IS NOT NULL) AS has_key,
              w.status AS wa_status, w.phone AS wa_phone,
              (SELECT COUNT(*) FROM chats c WHERE c.user_id = u.id) AS chats,
              (SELECT COUNT(*) FROM messages m WHERE m.user_id = u.id AND m.created_at >= ?) AS messages_30d
         FROM users u LEFT JOIN wa_connections w ON w.session_id = 'u:' || u.id
        ORDER BY u.created_at DESC LIMIT 1000`,
      Date.now() - 30 * 24 * 3600_000,
    );
    return {
      sender: wa.view(SYSTEM_SESSION),
      admin_phone_set: Boolean(adminPhone),
      today: todayLocal(),
      users: users.map((u) => ({
        id: u.id,
        name: u.name,
        company: u.company,
        phone: u.phone,
        created_at: u.created_at,
        wa_status: wa.isConnected(`u:${u.id}`) ? "connected" : (u.wa_status ?? "disconnected"),
        wa_phone: u.wa_phone,
        chats: u.chats,
        messages_30d: u.messages_30d,
        ai_access: accessView(u.ai_access_until),
        check: checkView(u.check_until, Boolean(u.has_key)),
      })),
    };
  });

  app.post("/api/admin/users/:id/access", { ...guard, config: { rateLimit: { max: 30, timeWindow: "1 minute" } } }, async (req) => {
    const { id } = parse(idParam, req.params);
    const body = parse(
      z.strictObject({ until: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Дата в формате ГГГГ-ММ-ДД").nullable() }),
      req.body,
    );
    const user = db.get<{ id: number; phone: string; ai_access_until: number | null }>(
      "SELECT id, phone, ai_access_until FROM users WHERE id = ?",
      id,
    );
    if (!user) throw new HttpError(404, "not_found", "Пользователь не найден");
    let until: number | null = null;
    if (body.until) {
      until = endOfLocalDay(body.until);
      const minUntil = endOfLocalDay(todayLocal());
      if (!Number.isFinite(until) || until < minUntil) {
        throw new HttpError(400, "validation", "Дата окончания не может быть в прошлом");
      }
      if (until > Date.now() + 5 * 366 * 24 * 3600_000) {
        throw new HttpError(400, "validation", "Максимальный срок — 5 лет");
      }
    }
    db.run("UPDATE users SET ai_access_until = ?, ai_access_notice = NULL WHERE id = ?", until, id);
    audit(db, {
      actor: "admin",
      action: until ? "ai_access_grant" : "ai_access_revoke",
      target: `user:${id}`,
      result: "ok",
      ip: req.ip,
      meta: { from: user.ai_access_until, to: until, phone: maskPhone(user.phone) },
    });
    if (until) void kb.reindexMissing(id).catch((err) => req.log.warn({ err }, "kb reindex after grant failed"));
    return { id, ai_access: accessView(until) };
  });

  /**
   * The chief's read-only view (check.<domain>) for one company. Enabling
   * issues an access key that is shown ONCE (only its keyed hash is
   * stored); rotating it or switching the feature off signs every chief
   * session out.
   */
  app.post("/api/admin/users/:id/check", { ...guard, config: { rateLimit: { max: 30, timeWindow: "1 minute" } } }, async (req) => {
    const { id } = parse(idParam, req.params);
    const body = parse(
      z.strictObject({
        until: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Дата в формате ГГГГ-ММ-ДД").nullable(),
        rotate: z.boolean().default(false),
      }),
      req.body,
    );
    const user = db.get<{ id: number; phone: string; check_until: number | null; check_token_hash: string | null }>(
      "SELECT id, phone, check_until, check_token_hash FROM users WHERE id = ?",
      id,
    );
    if (!user) throw new HttpError(404, "not_found", "Пользователь не найден");
    if (body.until === null) {
      db.tx(() => {
        db.run("UPDATE users SET check_until = NULL, check_token_hash = NULL WHERE id = ?", id);
        db.run("DELETE FROM check_sessions WHERE user_id = ?", id);
      });
      audit(db, { actor: "admin", action: "check_revoke", target: `user:${id}`, result: "ok", ip: req.ip, meta: { phone: maskPhone(user.phone) } });
      return { id, check: checkView(null, false), key: null };
    }
    const until = parseUntil(body.until);
    let key: string | null = null;
    db.tx(() => {
      db.run("UPDATE users SET check_until = ? WHERE id = ?", until, id);
      if (!user.check_token_hash || body.rotate) {
        key = newAccessKey();
        db.run("UPDATE users SET check_token_hash = ? WHERE id = ?", keyHash(checkSealer, key), id);
        db.run("DELETE FROM check_sessions WHERE user_id = ?", id);
      }
    });
    audit(db, {
      actor: "admin",
      action: key ? (user.check_token_hash ? "check_key_rotate" : "check_grant") : "check_extend",
      target: `user:${id}`,
      result: "ok",
      ip: req.ip,
      meta: { from: user.check_until, to: until, phone: maskPhone(user.phone) },
    });
    return { id, check: checkView(until, true), key };
  });

  /** Security journal: admin logins, failures, access changes. */
  app.get("/api/admin/audit", guard, async () => {
    const rows = db.all<{ at: number; action: string; result: string; ip: string | null; target: string | null; meta: string | null }>(
      `SELECT at, action, result, ip, target, meta FROM audit_log
        WHERE action LIKE 'admin_%' OR action LIKE 'sender_%' OR action LIKE 'ai_access_%'
           OR action IN ('check_grant', 'check_extend', 'check_key_rotate', 'check_revoke')
        ORDER BY id DESC LIMIT 60`,
    );
    return {
      items: rows.map((r) => ({ ...r, meta: r.meta ? (JSON.parse(r.meta) as Record<string, unknown>) : null })),
    };
  });

  /* ---------- OTP sender (security-critical: sees every code it sends) ---------- */

  app.get("/api/admin/sender", guard, async () => wa.view(SYSTEM_SESSION));

  app.post("/api/admin/sender/link", { ...guard, ...RL_STRICT }, async (req) => {
    const body = parse(
      z.discriminatedUnion("method", [
        z.strictObject({ method: z.literal("qr") }),
        z.strictObject({ method: z.literal("code"), phone: phoneField }),
      ]),
      req.body,
    );
    await wa.link(SYSTEM_SESSION, null, body.method, body.method === "code" ? body.phone : undefined);
    audit(db, { actor: "admin", action: "sender_link_start", result: "ok", ip: req.ip, meta: { method: body.method } });
    return wa.view(SYSTEM_SESSION);
  });

  app.post("/api/admin/sender/cancel", guard, async () => {
    await wa.cancel(SYSTEM_SESSION);
    return wa.view(SYSTEM_SESSION);
  });

  app.post("/api/admin/sender/logout", guard, async (req) => {
    await wa.logout(SYSTEM_SESSION);
    audit(db, { actor: "admin", action: "sender_logout", result: "ok", ip: req.ip });
    return wa.view(SYSTEM_SESSION);
  });
}
