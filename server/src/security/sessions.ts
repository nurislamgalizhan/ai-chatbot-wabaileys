import type { FastifyReply, FastifyRequest } from "fastify";
import type { Db } from "../db.ts";
import { HttpError } from "../lib/errors.ts";
import { randomToken, sha256 } from "./crypto.ts";

export const USER_COOKIE = "alma_sid";
export const ADMIN_COOKIE = "alma_admin";
export const ADMIN_PENDING_COOKIE = "alma_2fa";

const USER_TTL = 30 * 24 * 3600 * 1000; // sliding 30 days
const TOUCH_EVERY = 12 * 3600 * 1000;
const ADMIN_TTL = 8 * 3600 * 1000; // absolute 8 hours
const ADMIN_IDLE = 30 * 60 * 1000; // logged out after 30 min of inactivity
const ADMIN_MFA_TTL = 10 * 60 * 1000;
/** The admin cookie is only ever sent to the admin API, never cross-site. */
const ADMIN_PATH = "/api/admin";

export interface AuthUser {
  id: number;
  phone: string;
  name: string;
  company: string;
  created_at: number;
}

declare module "fastify" {
  interface FastifyRequest {
    user?: AuthUser;
  }
}

function cookieOpts(secure: boolean, maxAgeMs: number) {
  return {
    path: "/",
    httpOnly: true,
    secure,
    sameSite: "lax" as const,
    maxAge: Math.floor(maxAgeMs / 1000),
  };
}

/* ---------- User sessions ---------- */

/** Always issues a brand-new token (session fixation is impossible). */
export function startUserSession(db: Db, reply: FastifyReply, userId: number, secure: boolean) {
  const token = randomToken();
  const now = Date.now();
  db.run(
    "INSERT INTO sessions (id_hash, user_id, created_at, expires_at, touched_at) VALUES (?, ?, ?, ?, ?)",
    sha256(token),
    userId,
    now,
    now + USER_TTL,
    now,
  );
  reply.setCookie(USER_COOKIE, token, cookieOpts(secure, USER_TTL));
}

export function endUserSession(db: Db, req: FastifyRequest, reply: FastifyReply, secure: boolean) {
  const token = req.cookies[USER_COOKIE];
  if (token) db.run("DELETE FROM sessions WHERE id_hash = ?", sha256(token));
  reply.clearCookie(USER_COOKIE, cookieOpts(secure, 0));
}

export function revokeOtherSessions(db: Db, userId: number, keepToken?: string) {
  if (keepToken) {
    db.run("DELETE FROM sessions WHERE user_id = ? AND id_hash <> ?", userId, sha256(keepToken));
  } else {
    db.run("DELETE FROM sessions WHERE user_id = ?", userId);
  }
}

export function resolveUser(db: Db, token: string | undefined): AuthUser | null {
  if (!token || token.length > 128) return null;
  const idHash = sha256(token);
  const now = Date.now();
  const row = db.get<AuthUser & { expires_at: number; touched_at: number }>(
    `SELECT u.id, u.phone, u.name, u.company, u.created_at, s.expires_at, s.touched_at
       FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.id_hash = ?`,
    idHash,
  );
  if (!row) return null;
  if (row.expires_at <= now) {
    db.run("DELETE FROM sessions WHERE id_hash = ?", idHash);
    return null;
  }
  if (now - row.touched_at > TOUCH_EVERY) {
    db.run(
      "UPDATE sessions SET touched_at = ?, expires_at = ? WHERE id_hash = ?",
      now,
      now + USER_TTL,
      idHash,
    );
  }
  return { id: row.id, phone: row.phone, name: row.name, company: row.company, created_at: row.created_at };
}

/** preHandler: deny by default, attach the verified user. */
export function requireUser(db: Db) {
  return async (req: FastifyRequest) => {
    const user = resolveUser(db, req.cookies[USER_COOKIE]);
    if (!user) throw new HttpError(401, "unauthorized", "Требуется вход");
    req.user = user;
  };
}

/* ---------- Admin sessions ----------
 * The admin signs in through the ordinary /login form. After the correct
 * admin password a short-lived "pending" session exists whose cookie is
 * only sent to /api/auth/2fa; the full session cookie is only sent to
 * /api/admin. Neither works anywhere else. */

const ADMIN_PENDING_PATH = "/api/auth/2fa";

const scopedCookie = (secure: boolean, maxAgeMs: number, path: string) => ({
  ...cookieOpts(secure, maxAgeMs),
  path,
  sameSite: "strict" as const,
});

function insertAdminRow(db: Db, pending: boolean, credFp: string): string {
  const token = randomToken();
  const now = Date.now();
  db.run(
    `INSERT INTO admin_sessions (id_hash, created_at, expires_at, mfa_pending, touched_at, cred_fp)
     VALUES (?, ?, ?, ?, ?, ?)`,
    sha256(token),
    now,
    now + (pending ? ADMIN_MFA_TTL : ADMIN_TTL),
    pending ? 1 : 0,
    now,
    credFp,
  );
  return token;
}

/** Step 1 passed (password): wait for the second factor. */
export function startPendingAdmin(db: Db, reply: FastifyReply, secure: boolean, credFp: string) {
  reply.setCookie(ADMIN_PENDING_COOKIE, insertAdminRow(db, true, credFp), scopedCookie(secure, ADMIN_MFA_TTL, ADMIN_PENDING_PATH));
}

/** Both factors passed: a brand-new token (never the pending one). */
export function startAdminSession(db: Db, reply: FastifyReply, secure: boolean, credFp: string) {
  reply.setCookie(ADMIN_COOKIE, insertAdminRow(db, false, credFp), scopedCookie(secure, ADMIN_TTL, ADMIN_PATH));
}

/** Fails closed: expired, idle, wrong kind, or minted for another password. */
function checkAdminRow(db: Db, token: string | undefined, credFp: string, pending: boolean): boolean {
  if (!token || token.length > 128) return false;
  const idHash = sha256(token);
  const row = db.get<{ expires_at: number; mfa_pending: number; touched_at: number; cred_fp: string }>(
    "SELECT expires_at, mfa_pending, touched_at, cred_fp FROM admin_sessions WHERE id_hash = ?",
    idHash,
  );
  const now = Date.now();
  if (!row) return false;
  if (row.expires_at <= now || now - row.touched_at > ADMIN_IDLE || row.cred_fp !== credFp) {
    db.run("DELETE FROM admin_sessions WHERE id_hash = ?", idHash);
    return false;
  }
  if (Boolean(row.mfa_pending) !== pending) return false;
  if (!pending) db.run("UPDATE admin_sessions SET touched_at = ? WHERE id_hash = ?", now, idHash);
  return true;
}

export const isPendingAdmin = (db: Db, req: FastifyRequest, credFp: string) =>
  checkAdminRow(db, req.cookies[ADMIN_PENDING_COOKIE], credFp, true);

export const isAdmin = (db: Db, req: FastifyRequest, credFp: string) =>
  checkAdminRow(db, req.cookies[ADMIN_COOKIE], credFp, false);

export function endPendingAdmin(db: Db, req: FastifyRequest, reply: FastifyReply, secure: boolean) {
  const token = req.cookies[ADMIN_PENDING_COOKIE];
  if (token) db.run("DELETE FROM admin_sessions WHERE id_hash = ?", sha256(token));
  reply.clearCookie(ADMIN_PENDING_COOKIE, scopedCookie(secure, 0, ADMIN_PENDING_PATH));
}

export function endAdminSession(db: Db, req: FastifyRequest, reply: FastifyReply, secure: boolean) {
  const token = req.cookies[ADMIN_COOKIE];
  if (token) db.run("DELETE FROM admin_sessions WHERE id_hash = ?", sha256(token));
  reply.clearCookie(ADMIN_COOKIE, scopedCookie(secure, 0, ADMIN_PATH));
}

export function endAllAdminSessions(db: Db) {
  db.run("DELETE FROM admin_sessions");
}

/** Without a full admin session the admin API answers exactly like a
 *  route that does not exist: outsiders cannot even tell it is there. */
export function requireAdmin(db: Db, credFp: () => string) {
  return async (req: FastifyRequest) => {
    if (!isAdmin(db, req, credFp())) throw new HttpError(404, "not_found", "Не найдено");
  };
}

export function purgeExpiredSessions(db: Db) {
  const now = Date.now();
  db.run("DELETE FROM sessions WHERE expires_at <= ?", now);
  db.run("DELETE FROM admin_sessions WHERE expires_at <= ?", now);
  db.run("DELETE FROM otp_codes WHERE created_at < ?", now - 7 * 24 * 3600 * 1000);
}
