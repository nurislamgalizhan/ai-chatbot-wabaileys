import type { FastifyBaseLogger } from "fastify";
import type { Db } from "../db.ts";
import { maskPhone } from "../lib/phone.ts";
import { localParts } from "../lib/time.ts";
import { SYSTEM_SESSION, type WaManager } from "../wa/manager.ts";

const DAY = 24 * 3600_000;
const WARN_BEFORE = 3 * DAY;

/** The single place that answers "may this account use the AI now?". */
export function hasAiAccess(db: Db, userId: number, now = Date.now()): boolean {
  const row = db.get<{ ai_access_until: number | null }>("SELECT ai_access_until FROM users WHERE id = ?", userId);
  return Boolean(row?.ai_access_until && row.ai_access_until > now);
}

export function accessView(until: number | null, now = Date.now()) {
  return {
    until,
    active: Boolean(until && until > now),
    days_left: until && until > now ? Math.ceil((until - now) / DAY) : 0,
  };
}

/** "2026-12-31" -> 23:59:59.999 of that day in Almaty (UTC+5, no DST). */
export function endOfLocalDay(isoDate: string): number {
  return Date.parse(`${isoDate}T23:59:59.999+05:00`);
}

export function todayLocal(now = Date.now()): string {
  return localParts(now).day;
}

export function trialUntil(days: number, now = Date.now()): number | null {
  if (days <= 0) return null;
  return endOfLocalDay(localParts(now + days * DAY).day);
}

const fmt = (ms: number) =>
  new Intl.DateTimeFormat("ru-RU", { timeZone: "Asia/Almaty", day: "2-digit", month: "2-digit", year: "numeric" }).format(ms);

/**
 * Hourly: tells clients in WhatsApp (from the system sender) that AI access
 * ends in ≤3 days, and that it has ended. Each notice is sent once per
 * expiry date (remembered in users.ai_access_notice).
 */
export async function sendAccessNotices(db: Db, wa: WaManager, log: FastifyBaseLogger, support?: string) {
  if (!wa.isConnected(SYSTEM_SESSION)) return;
  const now = Date.now();
  const rows = db.all<{ id: number; phone: string; ai_access_until: number; ai_access_notice: string | null }>(
    `SELECT id, phone, ai_access_until, ai_access_notice FROM users
      WHERE ai_access_until IS NOT NULL AND ai_access_until BETWEEN ? AND ?`,
    now - 2 * DAY,
    now + WARN_BEFORE,
  );
  const contact = support ? `\nПродлить: https://wa.me/${support.replace(/\D/g, "")}` : "";
  for (const u of rows) {
    const expired = u.ai_access_until <= now;
    const key = `${expired ? "exp" : "soon"}:${u.ai_access_until}`;
    if (u.ai_access_notice === key) continue;
    const text = expired
      ? `*Alma AI*\nДоступ к AI-агенту закончился ${fmt(u.ai_access_until)}. Бот больше не отвечает клиентам автоматически — диалоги по-прежнему видны в кабинете.${contact}`
      : `*Alma AI*\nДоступ к AI-агенту действует до ${fmt(u.ai_access_until)}. Продлите его, чтобы бот продолжал отвечать клиентам без перерыва.${contact}`;
    try {
      await wa.sendText(SYSTEM_SESSION, `${u.phone}@s.whatsapp.net`, text);
      db.run("UPDATE users SET ai_access_notice = ? WHERE id = ?", key, u.id);
    } catch (err) {
      log.warn({ err, phone: maskPhone(u.phone) }, "access notice failed");
    }
  }
}
