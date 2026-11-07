import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { DEFAULT_HANDOFF } from "../ai/prompt.ts";
import type { Ctx } from "../context.ts";
import { HttpError } from "../lib/errors.ts";
import { maskPhone } from "../lib/phone.ts";
import { audit, recentFailures } from "../security/audit.ts";
import { dummyPasswordHash, hashPassword, verifyPassword } from "../security/crypto.ts";
import {
  type AuthUser,
  endUserSession,
  requireUser,
  revokeOtherSessions,
  startUserSession,
  USER_COOKIE,
} from "../security/sessions.ts";
import { accessView, trialUntil } from "../services/access.ts";
import { adminLogin } from "./adminLogin.ts";
import { parse, passwordField, phoneField, RL_AUTH, RL_STRICT, userId } from "./util.ts";

const LOGIN_WINDOW = 15 * 60_000;
const LOGIN_MAX_FAILS = 5;

const publicUser = (u: AuthUser) => ({
  id: u.id,
  name: u.name,
  company: u.company,
  phone: u.phone,
  created_at: u.created_at,
});

export function authRoutes(app: FastifyInstance, ctx: Ctx) {
  const { db, otp, cfg } = ctx;
  const secure = cfg.isProd;
  const admin = adminLogin(ctx);
  admin.routes(app);

  /** What the cabinet needs about the signed-in account. */
  const meView = (u: AuthUser) => {
    const row = db.get<{ ai_access_until: number | null }>("SELECT ai_access_until FROM users WHERE id = ?", u.id);
    return {
      user: publicUser(u),
      ai_access: accessView(row?.ai_access_until ?? null),
      support_whatsapp: cfg.SUPPORT_WHATSAPP ? cfg.SUPPORT_WHATSAPP.replace(/\D/g, "") : null,
    };
  };

  app.post("/api/auth/register/start", RL_AUTH, async (req) => {
    const body = parse(
      z.strictObject({
        name: z.string().trim().min(2, "Укажите имя").max(80),
        company: z.string().trim().max(120).default(""),
        phone: phoneField,
        password: passwordField,
      }),
      req.body,
    );
    // The admin's number is "taken" like any registered one.
    if (admin.isAdminPhone(body.phone) || db.get("SELECT id FROM users WHERE phone = ?", body.phone)) {
      throw new HttpError(409, "phone_taken", "Этот номер уже зарегистрирован. Войдите или восстановите пароль.");
    }
    const passwordHash = await hashPassword(body.password);
    const sent = await otp.issue({
      phone: body.phone,
      purpose: "register",
      ip: req.ip,
      payload: { name: body.name, company: body.company, password_hash: passwordHash },
    });
    audit(db, { actor: "anon", action: "register_otp", target: body.phone, result: "ok", ip: req.ip });
    return { ok: true, ...sent };
  });

  app.post("/api/auth/register/verify", RL_AUTH, async (req, reply) => {
    const body = parse(
      z.strictObject({ phone: phoneField, code: z.string().trim().max(6) }),
      req.body,
    );
    let payload: Record<string, unknown>;
    try {
      payload = otp.verify(body.phone, "register", body.code);
    } catch (err) {
      audit(db, { actor: "anon", action: "register_verify", target: body.phone, result: "fail", ip: req.ip });
      throw err;
    }
    const data = z
      .object({ name: z.string(), company: z.string(), password_hash: z.string() })
      .parse(payload);
    const now = Date.now();
    const id = db.tx(() => {
      if (admin.isAdminPhone(body.phone) || db.get("SELECT id FROM users WHERE phone = ?", body.phone)) {
        throw new HttpError(409, "phone_taken", "Этот номер уже зарегистрирован. Войдите в аккаунт.");
      }
      const uid = db.run(
        `INSERT INTO users (phone, name, company, password_hash, created_at, updated_at, ai_access_until)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        body.phone,
        data.name,
        data.company,
        data.password_hash,
        now,
        now,
        trialUntil(cfg.AI_TRIAL_DAYS, now),
      ).lastInsertRowid;
      db.run(
        "INSERT INTO agent_settings (user_id, business_name, handoff_message, updated_at) VALUES (?, ?, ?, ?)",
        uid,
        data.company,
        DEFAULT_HANDOFF,
        now,
      );
      return uid;
    });
    startUserSession(db, reply, id, secure);
    audit(db, { actor: `user:${id}`, action: "register", target: body.phone, result: "ok", ip: req.ip });
    req.log.info({ userId: id, phone: maskPhone(body.phone) }, "user registered");
    return meView({ id, name: data.name, company: data.company, phone: body.phone, created_at: now });
  });

  app.post("/api/auth/login", RL_AUTH, async (req, reply) => {
    const body = parse(
      z.strictObject({ phone: phoneField, password: z.string().min(1).max(128) }),
      req.body,
    );
    // Same form, same errors, same Argon2 cost — the admin path is invisible.
    if (admin.isAdminPhone(body.phone)) return admin.passwordStep(req, reply, body.password);
    if (recentFailures(db, "login", body.phone, LOGIN_WINDOW) >= LOGIN_MAX_FAILS) {
      throw new HttpError(429, "locked", "Слишком много попыток. Подождите 15 минут или восстановите пароль.");
    }
    const user = db.get<AuthUser & { password_hash: string }>(
      "SELECT id, phone, name, company, created_at, password_hash FROM users WHERE phone = ?",
      body.phone,
    );
    // Same work for unknown phones: no account enumeration via timing.
    const ok = await verifyPassword(body.password, user?.password_hash ?? (await dummyPasswordHash()));
    if (!user || !ok) {
      audit(db, { actor: "anon", action: "login", target: body.phone, result: "fail", ip: req.ip });
      throw new HttpError(401, "bad_credentials", "Неверный номер или пароль");
    }
    startUserSession(db, reply, user.id, secure);
    audit(db, { actor: `user:${user.id}`, action: "login", target: body.phone, result: "ok", ip: req.ip });
    return meView(user);
  });

  app.post("/api/auth/logout", async (req, reply) => {
    endUserSession(db, req, reply, secure);
    return { ok: true };
  });

  app.post("/api/auth/reset/start", RL_AUTH, async (req) => {
    const body = parse(z.strictObject({ phone: phoneField }), req.body);
    // The admin's password is reset on the server (npm run admin:hash), never by SMS/WhatsApp.
    const exists = !admin.isAdminPhone(body.phone) && Boolean(db.get("SELECT id FROM users WHERE phone = ?", body.phone));
    const sent = await otp.issue({ phone: body.phone, purpose: "reset", ip: req.ip, silent: !exists });
    audit(db, { actor: "anon", action: "reset_otp", target: body.phone, result: exists ? "ok" : "fail", ip: req.ip });
    // Identical answer either way: the endpoint does not reveal accounts.
    return { ok: true, ...sent };
  });

  app.post("/api/auth/reset/verify", RL_AUTH, async (req, reply) => {
    const body = parse(
      z.strictObject({ phone: phoneField, code: z.string().trim().max(6), password: passwordField }),
      req.body,
    );
    try {
      otp.verify(body.phone, "reset", body.code);
    } catch (err) {
      audit(db, { actor: "anon", action: "reset_verify", target: body.phone, result: "fail", ip: req.ip });
      throw err;
    }
    const user = db.get<AuthUser>(
      "SELECT id, phone, name, company, created_at FROM users WHERE phone = ?",
      body.phone,
    );
    if (!user) throw new HttpError(400, "otp_invalid", "Неверный или просроченный код");
    const hash = await hashPassword(body.password);
    db.run("UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?", hash, Date.now(), user.id);
    revokeOtherSessions(db, user.id);
    startUserSession(db, reply, user.id, secure);
    audit(db, { actor: `user:${user.id}`, action: "password_reset", target: body.phone, result: "ok", ip: req.ip });
    return meView(user);
  });

  /* ---------- current account ---------- */

  const auth = { preHandler: requireUser(db) };

  app.get("/api/me", auth, async (req) => meView(req.user!));

  app.patch("/api/me", auth, async (req) => {
    const body = parse(
      z.strictObject({
        name: z.string().trim().min(2, "Укажите имя").max(80),
        company: z.string().trim().max(120),
      }),
      req.body,
    );
    const id = userId(req);
    db.run("UPDATE users SET name = ?, company = ?, updated_at = ? WHERE id = ?", body.name, body.company, Date.now(), id);
    return meView({ ...req.user!, name: body.name, company: body.company });
  });

  app.post("/api/me/password", { ...auth, ...RL_STRICT }, async (req) => {
    const body = parse(
      z.strictObject({ current_password: z.string().min(1).max(128), new_password: passwordField }),
      req.body,
    );
    const id = userId(req);
    const row = db.get<{ password_hash: string }>("SELECT password_hash FROM users WHERE id = ?", id);
    if (!row || !(await verifyPassword(body.current_password, row.password_hash))) {
      audit(db, { actor: `user:${id}`, action: "password_change", result: "fail", ip: req.ip });
      throw new HttpError(400, "bad_password", "Текущий пароль указан неверно");
    }
    db.run("UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?", await hashPassword(body.new_password), Date.now(), id);
    revokeOtherSessions(db, id, req.cookies[USER_COOKIE]);
    audit(db, { actor: `user:${id}`, action: "password_change", result: "ok", ip: req.ip });
    return { ok: true };
  });

  app.post("/api/me/delete", { ...auth, ...RL_STRICT }, async (req, reply) => {
    const body = parse(z.strictObject({ password: z.string().min(1).max(128) }), req.body);
    const id = userId(req);
    const row = db.get<{ password_hash: string; phone: string }>("SELECT password_hash, phone FROM users WHERE id = ?", id);
    if (!row || !(await verifyPassword(body.password, row.password_hash))) {
      audit(db, { actor: `user:${id}`, action: "account_delete", result: "fail", ip: req.ip });
      throw new HttpError(400, "bad_password", "Пароль указан неверно");
    }
    await ctx.wa.logout(`u:${id}`);
    db.tx(() => {
      db.run("DELETE FROM wa_connections WHERE session_id = ?", `u:${id}`);
      db.run("DELETE FROM users WHERE id = ?", id);
    });
    ctx.kb.invalidate(id);
    ctx.media.removeUser(id);
    endUserSession(db, req, reply, secure);
    audit(db, { actor: `user:${id}`, action: "account_delete", target: row.phone, result: "ok", ip: req.ip });
    return { ok: true };
  });
}
