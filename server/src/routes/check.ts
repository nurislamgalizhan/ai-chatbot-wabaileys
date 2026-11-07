import type { FastifyInstance, FastifyRequest } from "fastify";
import { jidNormalizedUser } from "baileys";
import { z } from "zod";
import type { Ctx } from "../context.ts";
import { HttpError, notFound } from "../lib/errors.ts";
import { startOfLocalDay } from "../lib/time.ts";
import { audit, recentFailures } from "../security/audit.ts";
import { Sealer } from "../security/crypto.ts";
import { accessView } from "../services/access.ts";
import {
  CHECK_COOKIE,
  type CheckUser,
  endCheckSession,
  keyHash,
  normalizeKey,
  resolveCheckUser,
  startCheckSession,
} from "../services/check.ts";
import { userSessionId } from "../wa/manager.ts";
import { sniff } from "../wa/media.ts";
import { summarize } from "./analytics.ts";
import { chatDetail, listChats, pageMessages, requestOlderHistory, serveMedia } from "./shared.ts";
import { idParam, parse } from "./util.ts";

declare module "fastify" {
  interface FastifyRequest {
    checkUser?: CheckUser;
  }
}

const LOCK_WINDOW = 15 * 60_000;
const LOCK_FAILS = 10;
const DAY = 24 * 3600_000;
const PROFILE_TTL = 3600_000;
const MAX_AVATAR = 1024 * 1024;

/**
 * The chief's read-only view of the company's WhatsApp, served only on the
 * check.<domain> host. It reuses the company's existing linked session —
 * no second linked device — and never changes anything managers see:
 * no read receipts, no "read" marks, no attention flags, no replies.
 */
export function checkRoutes(app: FastifyInstance, ctx: Ctx) {
  const { db, cfg, wa } = ctx;
  const secure = cfg.isProd;
  const sealer = new Sealer(cfg.appSecret, "check-key-v1");
  const profiles = new Map<string, { at: number; data: unknown }>();

  /** Only on the check host: from the managers' app host it does not exist. */
  const onCheckHost = (req: FastifyRequest) => {
    if (req.hostname !== cfg.checkHost) throw notFound("Не найдено");
  };
  const auth = {
    preHandler: async (req: FastifyRequest) => {
      onCheckHost(req);
      const u = resolveCheckUser(db, req.cookies[CHECK_COOKIE]);
      if (!u) throw new HttpError(401, "unauthorized", "Введите ключ доступа");
      req.checkUser = u;
    },
  };
  const uidOf = (req: FastifyRequest) => req.checkUser!.id;

  /* ---------- sign in with the access key ---------- */

  app.post("/api/check/login", { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } }, async (req, reply) => {
    onCheckHost(req);
    const body = parse(z.strictObject({ key: z.string().trim().min(10).max(64) }), req.body);
    if (recentFailures(db, "check_login", req.ip, LOCK_WINDOW) >= LOCK_FAILS) {
      throw new HttpError(429, "locked", "Слишком много попыток. Подождите 15 минут.");
    }
    const user = db.get<{ id: number; check_until: number | null }>(
      "SELECT id, check_until FROM users WHERE check_token_hash = ?",
      keyHash(sealer, body.key),
    );
    if (!user || normalizeKey(body.key).length !== 24 || !user.check_until || user.check_until <= Date.now()) {
      audit(db, { actor: "anon", action: "check_login", target: req.ip, result: "fail", ip: req.ip });
      throw new HttpError(401, "bad_key", "Неверный или недействующий ключ доступа");
    }
    endCheckSession(db, req, reply, secure);
    startCheckSession(db, reply, user.id, secure);
    audit(db, { actor: `check:${user.id}`, action: "check_login", target: `user:${user.id}`, result: "ok", ip: req.ip });
    return { ok: true };
  });

  app.post("/api/check/logout", async (req, reply) => {
    onCheckHost(req);
    endCheckSession(db, req, reply, secure);
    return { ok: true };
  });

  /* ---------- read-only data ---------- */

  app.get("/api/check/me", auth, async (req) => {
    const u = req.checkUser!;
    const row = db.get<{ ai_access_until: number | null }>("SELECT ai_access_until FROM users WHERE id = ?", u.id);
    const counts = db.get<{ chats: number; messages: number }>(
      "SELECT (SELECT COUNT(*) FROM chats WHERE user_id = ?) AS chats, (SELECT COUNT(*) FROM messages WHERE user_id = ?) AS messages",
      u.id,
      u.id,
    );
    const w = wa.view(userSessionId(u.id));
    return {
      company: u.company || u.name,
      check_until: u.check_until,
      ai_access: accessView(row?.ai_access_until ?? null),
      whatsapp: { status: w.status, phone: w.phone, name: w.name },
      chats: counts?.chats ?? 0,
      messages: counts?.messages ?? 0,
    };
  });

  app.get("/api/check/chats", auth, async (req) => {
    const q = parse(
      z.object({
        filter: z.enum(["all", "attention", "human", "deleted"]).default("all"),
        q: z.string().trim().max(80).default(""),
        cursor: z.string().regex(/^\d+_\d+$/).optional(),
      }),
      req.query,
    );
    return listChats(db, uidOf(req), q);
  });

  app.get("/api/check/chats/:id", auth, async (req) => {
    const { id } = parse(idParam, req.params);
    const detail = chatDetail(db, uidOf(req), id);
    const extra = db.get<{ deleted: number; edited: number; first_at: number | null }>(
      `SELECT SUM(deleted_at IS NOT NULL) AS deleted, SUM(edited_at IS NOT NULL) AS edited, MIN(created_at) AS first_at
         FROM messages WHERE chat_id = ? AND user_id = ?`,
      id,
      uidOf(req),
    );
    return { ...detail, deleted_count: extra?.deleted ?? 0, edited_count: extra?.edited ?? 0, first_message_at: extra?.first_at ?? null };
  });

  /** Everything, including what was deleted for everyone and edit history. */
  app.get("/api/check/chats/:id/messages", auth, async (req) => {
    const { id } = parse(idParam, req.params);
    const q = parse(z.object({ before: z.coerce.number().int().positive().optional() }), req.query);
    const uid = uidOf(req);
    const page = pageMessages(db, uid, id, q.before);
    const editedIds = page.items.filter((m) => m.edited_at !== null).map((m) => m.id);
    const edits = new Map<number, { body: string | null; at: number }[]>();
    if (editedIds.length) {
      // Placeholders only — the ids come from our own query above.
      const rows = db.all<{ message_id: number; body: string | null; at: number }>(
        `SELECT message_id, body, at FROM message_edits WHERE message_id IN (${editedIds.map(() => "?").join(",")}) ORDER BY at`,
        ...editedIds,
      );
      for (const r of rows) edits.set(r.message_id, [...(edits.get(r.message_id) ?? []), { body: r.body, at: r.at }]);
    }
    return {
      items: page.items.map((m) => ({
        ...m,
        handoff: Boolean(m.handoff),
        deleted: m.deleted_at !== null,
        edited: m.edited_at !== null,
        edits: edits.get(m.id) ?? [],
      })),
      next_before: page.next_before,
    };
  });

  app.get("/api/check/chats/:id/messages/:mid/media", auth, async (req, reply) => {
    const p = parse(
      z.strictObject({ id: z.coerce.number().int().positive().max(2 ** 40), mid: z.coerce.number().int().positive().max(2 ** 40) }),
      req.params,
    );
    return serveMedia(ctx, req, reply, uidOf(req), p.id, p.mid, true);
  });

  app.post("/api/check/chats/:id/history", { ...auth, config: { rateLimit: { max: 6, timeWindow: "1 minute" } } }, async (req) => {
    const { id } = parse(idParam, req.params);
    return requestOlderHistory(ctx, uidOf(req), id);
  });

  /** Live WhatsApp profile: photo, "about", business card (cached 1 h). */
  app.get("/api/check/chats/:id/profile", { ...auth, config: { rateLimit: { max: 60, timeWindow: "1 minute" } } }, async (req) => {
    const { id } = parse(idParam, req.params);
    const uid = uidOf(req);
    const chat = db.get<{ jid: string; phone: string | null }>("SELECT jid, phone FROM chats WHERE id = ? AND user_id = ?", id, uid);
    if (!chat) throw notFound("Чат не найден");
    const cacheKey = `${uid}:${id}`;
    const cached = profiles.get(cacheKey);
    if (cached && Date.now() - cached.at < PROFILE_TTL) return cached.data;
    const sock = wa.socket(userSessionId(uid));
    if (!sock) return { available: false };
    const jid = jidNormalizedUser(chat.jid);
    const [photoUrl, status, business] = await Promise.all([
      sock.profilePictureUrl(jid, "image", 8000).catch(() => undefined),
      sock.fetchStatus(jid).catch(() => undefined),
      sock.getBusinessProfile(jid).catch(() => undefined),
    ]);
    let photo: string | null = null;
    // The URL comes from WhatsApp; still, only fetch WhatsApp's own CDN (no SSRF).
    if (photoUrl) {
      try {
        const u = new URL(photoUrl);
        if (u.protocol === "https:" && u.hostname.endsWith(".whatsapp.net")) {
          const res = await fetch(u, { signal: AbortSignal.timeout(8000), redirect: "error" });
          const buf = Buffer.from(await res.arrayBuffer());
          const mime = sniff(buf);
          if (res.ok && buf.length <= MAX_AVATAR && mime.startsWith("image/")) {
            photo = `data:${mime};base64,${buf.toString("base64")}`;
          }
        }
      } catch {
        photo = null;
      }
    }
    const st = Array.isArray(status) ? (status[0] as { status?: { status?: string; setAt?: Date } } | undefined) : undefined;
    const b = business as
      | { description?: string; category?: string; website?: string[]; email?: string; address?: string }
      | undefined
      | void;
    const data = {
      available: true,
      photo,
      about: st?.status?.status ?? null,
      business: b
        ? {
            description: b.description ?? null,
            category: b.category ?? null,
            website: b.website?.[0] ?? null,
            email: b.email ?? null,
            address: b.address ?? null,
          }
        : null,
    };
    profiles.set(cacheKey, { at: Date.now(), data });
    return data;
  });

  /** Full-text search over every message (Russian/Kazakh, any case). */
  app.get("/api/check/search", { ...auth, config: { rateLimit: { max: 60, timeWindow: "1 minute" } } }, async (req) => {
    const q = parse(z.object({ q: z.string().trim().min(2).max(100) }), req.query);
    const terms = q.q
      .split(/\s+/)
      .map((t) => t.replace(/[^\p{L}\p{N}]/gu, ""))
      .filter(Boolean)
      .slice(0, 6);
    if (terms.length === 0) return { items: [] };
    // Each term is quoted: user input can never become FTS syntax.
    const match = terms.map((t) => `"${t}"*`).join(" ");
    const rows = db.all<Record<string, string | number | null>>(
      `SELECT m.id, m.chat_id, m.direction, m.source, m.kind, m.created_at, m.deleted_at,
              snippet(messages_fts, -1, char(2), char(3), '…', 14) AS snippet, c.name, c.phone
         FROM messages_fts
         JOIN messages m ON m.id = messages_fts.rowid
         JOIN chats c ON c.id = m.chat_id
        WHERE messages_fts MATCH ? AND m.user_id = ?
        ORDER BY m.created_at DESC LIMIT 60`,
      match,
      uidOf(req),
    );
    return { items: rows.map((r) => ({ ...r, deleted: r.deleted_at !== null })) };
  });

  app.get("/api/check/calls", auth, async (req) => {
    const rows = db.all<Record<string, string | number | null>>(
      `SELECT k.id, k.chat_id, k.phone, k.is_video, k.status, k.started_at, k.updated_at, c.name
         FROM calls k LEFT JOIN chats c ON c.id = k.chat_id
        WHERE k.user_id = ? ORDER BY k.started_at DESC LIMIT 200`,
      uidOf(req),
    );
    return {
      items: rows.map((r) => ({
        ...r,
        is_video: Boolean(r.is_video),
        outcome: r.status === "accept" ? "answered" : r.status === "reject" ? "rejected" : "missed",
      })),
    };
  });

  /** Team overview: who answers, how fast, what got deleted, missed calls. */
  app.get("/api/check/summary", auth, async (req) => {
    const q = parse(z.object({ days: z.coerce.number().int().refine((d) => [1, 7, 30].includes(d)).default(7) }), req.query);
    const uid = uidOf(req);
    const from = startOfLocalDay(Date.now()) - (q.days - 1) * DAY;
    const rows = db.all<{ chat_id: number; direction: "in" | "out"; source: string; handoff: number; created_at: number }>(
      `SELECT chat_id, direction, source, handoff, created_at FROM messages
        WHERE user_id = ? AND created_at >= ? AND status <> 'failed' ORDER BY created_at`,
      uid,
      from,
    );
    const s = summarize(rows, from, q.days);
    const bySource = db.get<{ panel: number; phone: number; deleted_customer: number; deleted_business: number }>(
      `SELECT SUM(source = 'operator_panel') AS panel, SUM(source = 'operator_phone') AS phone,
              SUM(deleted_by = 'customer' AND deleted_at >= ?) AS deleted_customer,
              SUM(deleted_by = 'business' AND deleted_at >= ?) AS deleted_business
         FROM messages WHERE user_id = ? AND (created_at >= ? OR deleted_at >= ?)`,
      from,
      from,
      uid,
      from,
      from,
    );
    const calls = db.get<{ total: number; missed: number }>(
      `SELECT COUNT(*) AS total, SUM(status NOT IN ('accept', 'reject')) AS missed FROM calls WHERE user_id = ? AND started_at >= ?`,
      uid,
      from,
    );
    const waiting = db.get<{ n: number }>("SELECT COUNT(*) AS n FROM chats WHERE user_id = ? AND needs_attention = 1", uid);
    return {
      days: q.days,
      ...s,
      operator_split: { panel: bySource?.panel ?? 0, phone: bySource?.phone ?? 0 },
      deleted: { customer: bySource?.deleted_customer ?? 0, business: bySource?.deleted_business ?? 0 },
      calls: { total: calls?.total ?? 0, missed: calls?.missed ?? 0 },
      waiting_now: waiting?.n ?? 0,
    };
  });
}
