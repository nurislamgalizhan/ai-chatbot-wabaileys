import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { Ctx } from "../context.ts";
import { HttpError } from "../lib/errors.ts";
import { humanNow } from "../lib/time.ts";
import { audit, recentFailures } from "../security/audit.ts";
import { RECOVERY_FILE } from "../security/admin.ts";
import { endPendingAdmin, isPendingAdmin, startAdminSession, startPendingAdmin } from "../security/sessions.ts";
import { SYSTEM_SESSION } from "../wa/manager.ts";
import { parse, RL_STRICT } from "./util.ts";

const WINDOW = 15 * 60_000;
const MAX_FAILS_PER_IP = 5;
const MAX_FAILS_GLOBAL = 20; // distributed guessing from many IPs

// Exactly the texts a regular user sees — the admin path is indistinguishable.
const BAD_CREDENTIALS = () => new HttpError(401, "bad_credentials", "Неверный номер или пароль");
const LOCKED = () => new HttpError(429, "locked", "Слишком много попыток. Подождите 15 минут или восстановите пароль.");

/**
 * The platform owner signs in through the ordinary /login form with
 * ADMIN_PHONE + admin password. There is no separate admin login page or
 * endpoint to find. After the password a second factor is always required:
 * a code to the admin's WhatsApp, or a recovery code written to a file on
 * the server (needs shell access).
 */
export function adminLogin(ctx: Ctx) {
  const { db, cfg, wa, otp, adminAuth } = ctx;
  const secure = cfg.isProd;
  const fp = () => adminAuth.fingerprint();
  const whatsappFactor = () => Boolean(adminAuth.phone && wa.isConnected(SYSTEM_SESSION));

  const lockedOut = (req: FastifyRequest) => {
    const perIp = recentFailures(db, "admin_login", req.ip, WINDOW);
    const global =
      db.get<{ n: number }>(
        "SELECT COUNT(*) AS n FROM audit_log WHERE action = 'admin_login' AND result = 'fail' AND at > ?",
        Date.now() - WINDOW,
      )?.n ?? 0;
    return perIp >= MAX_FAILS_PER_IP || global >= MAX_FAILS_GLOBAL;
  };
  const failed = (req: FastifyRequest, step: string) =>
    audit(db, { actor: "anon", action: "admin_login", target: req.ip, result: "fail", ip: req.ip, meta: { step } });

  /** Called by POST /api/auth/login for the admin's phone number. */
  async function passwordStep(req: FastifyRequest, reply: FastifyReply, password: string) {
    if (lockedOut(req)) throw LOCKED();
    if (!(await adminAuth.verifyPassword(password))) {
      failed(req, "password");
      throw BAD_CREDENTIALS();
    }
    endPendingAdmin(db, req, reply, secure);
    startPendingAdmin(db, reply, secure, fp());
    let whatsapp = false;
    if (whatsappFactor()) {
      try {
        await otp.issue({ phone: adminAuth.phone!, purpose: "admin", ip: req.ip });
        whatsapp = true;
      } catch (err) {
        // "Too soon" still means a valid code is already in WhatsApp.
        whatsapp = err instanceof HttpError && err.code === "otp_too_soon";
        if (!whatsapp) req.log.warn({ err }, "admin OTP delivery failed");
      }
    }
    audit(db, { actor: "admin", action: "admin_password_ok", target: req.ip, result: "ok", ip: req.ip });
    return { two_factor: true as const, whatsapp };
  }

  function routes(app: FastifyInstance) {
    const needPending = (req: FastifyRequest) => {
      if (!isPendingAdmin(db, req, fp())) throw new HttpError(404, "not_found", "Не найдено");
    };

    app.post("/api/auth/2fa/recovery", RL_STRICT, async (req) => {
      needPending(req);
      adminAuth.issueRecoveryCode();
      audit(db, { actor: "admin", action: "admin_recovery_issued", target: req.ip, result: "ok", ip: req.ip });
      return { ok: true, file: RECOVERY_FILE };
    });

    app.post("/api/auth/2fa/verify", RL_STRICT, async (req, reply) => {
      needPending(req);
      const body = parse(
        z.strictObject({ method: z.enum(["whatsapp", "recovery"]), code: z.string().trim().min(6).max(10) }),
        req.body,
      );
      if (lockedOut(req)) throw LOCKED();
      let ok = false;
      if (body.method === "recovery") {
        ok = adminAuth.verifyRecoveryCode(body.code);
      } else if (adminAuth.phone) {
        try {
          otp.verify(adminAuth.phone, "admin", body.code);
          ok = true;
        } catch {
          ok = false;
        }
      }
      if (!ok) {
        failed(req, body.method);
        throw new HttpError(400, "otp_invalid", "Неверный или просроченный код");
      }
      endPendingAdmin(db, req, reply, secure);
      startAdminSession(db, reply, secure, fp()); // new id after the privilege change
      adminAuth.clearRecovery();
      audit(db, { actor: "admin", action: "admin_login", target: req.ip, result: "ok", ip: req.ip, meta: { factor: body.method } });
      if (adminAuth.phone && wa.isConnected(SYSTEM_SESSION)) {
        const ua = String(req.headers["user-agent"] ?? "").slice(0, 80);
        void wa
          .sendText(
            SYSTEM_SESSION,
            `${adminAuth.phone}@s.whatsapp.net`,
            `*Alma AI · безопасность*\nВыполнен вход в админ-панель.\n${humanNow()}\nIP: ${req.ip}\n${ua}\n\nЕсли это были не вы — смените пароль администратора и завершите все сеансы.`,
          )
          .catch(() => undefined);
      }
      return { admin: true };
    });

    app.post("/api/auth/2fa/cancel", async (req, reply) => {
      endPendingAdmin(db, req, reply, secure);
      return { ok: true };
    });
  }

  return { passwordStep, routes, isAdminPhone: (phone: string) => Boolean(adminAuth.configured && phone === adminAuth.phone) };
}
