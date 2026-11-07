import { randomInt } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { Db } from "../db.ts";
import { randomToken, type Sealer, sha256 } from "../security/crypto.ts";

/**
 * The chief's read-only view (check.<domain>). Access is a per-company
 * feature the platform admin switches on with an end date; the chief signs
 * in with a long random access key instead of a login. Managers never see
 * the key or the feature: it lives on its own host, API prefix and cookie.
 */

export const CHECK_COOKIE = "alma_chk";
const CHECK_PATH = "/api/check";
const SESSION_TTL = 30 * 24 * 3600_000; // sliding
const TOUCH_EVERY = 12 * 3600_000;

// No 0/O/1/I: easy to read aloud and retype.
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

/** 24 symbols × 5 bits = 120 bits of entropy, shown as XXXX-XXXX-…. */
export function newAccessKey(): string {
  const chars = Array.from({ length: 24 }, () => ALPHABET[randomInt(0, ALPHABET.length)]).join("");
  return chars.match(/.{4}/g)!.join("-");
}

export const normalizeKey = (raw: string) => raw.toUpperCase().replace(/[^A-Z0-9]/g, "");

export function keyHash(sealer: Sealer, raw: string): string {
  return sealer.mac(`check-key:${normalizeKey(raw)}`);
}

export function checkView(until: number | null, hasKey: boolean, now = Date.now()) {
  return {
    until,
    active: Boolean(until && until > now),
    days_left: until && until > now ? Math.ceil((until - now) / 86400_000) : 0,
    has_key: hasKey,
  };
}

const cookieOpts = (secure: boolean, maxAgeMs: number) => ({
  path: CHECK_PATH,
  httpOnly: true,
  secure,
  sameSite: "strict" as const,
  maxAge: Math.floor(maxAgeMs / 1000),
});

export function startCheckSession(db: Db, reply: FastifyReply, userId: number, secure: boolean) {
  const token = randomToken();
  const now = Date.now();
  db.run(
    "INSERT INTO check_sessions (id_hash, user_id, created_at, expires_at, touched_at) VALUES (?, ?, ?, ?, ?)",
    sha256(token),
    userId,
    now,
    now + SESSION_TTL,
    now,
  );
  reply.setCookie(CHECK_COOKIE, token, cookieOpts(secure, SESSION_TTL));
}

export function endCheckSession(db: Db, req: FastifyRequest, reply: FastifyReply, secure: boolean) {
  const token = req.cookies[CHECK_COOKIE];
  if (token) db.run("DELETE FROM check_sessions WHERE id_hash = ?", sha256(token));
  reply.clearCookie(CHECK_COOKIE, cookieOpts(secure, 0));
}

export interface CheckUser {
  id: number;
  name: string;
  company: string;
  check_until: number;
}

/** Fails closed: unknown, expired, or the feature was switched off. */
export function resolveCheckUser(db: Db, token: string | undefined): CheckUser | null {
  if (!token || token.length > 128) return null;
  const idHash = sha256(token);
  const now = Date.now();
  const row = db.get<CheckUser & { expires_at: number; touched_at: number }>(
    `SELECT u.id, u.name, u.company, u.check_until, s.expires_at, s.touched_at
       FROM check_sessions s JOIN users u ON u.id = s.user_id
      WHERE s.id_hash = ?`,
    idHash,
  );
  if (!row) return null;
  if (row.expires_at <= now || !row.check_until || row.check_until <= now) {
    db.run("DELETE FROM check_sessions WHERE id_hash = ?", idHash);
    return null;
  }
  if (now - row.touched_at > TOUCH_EVERY) {
    db.run("UPDATE check_sessions SET touched_at = ?, expires_at = ? WHERE id_hash = ?", now, now + SESSION_TTL, idHash);
  }
  return { id: row.id, name: row.name, company: row.company, check_until: row.check_until };
}

export function purgeCheckSessions(db: Db) {
  db.run("DELETE FROM check_sessions WHERE expires_at <= ?", Date.now());
}
