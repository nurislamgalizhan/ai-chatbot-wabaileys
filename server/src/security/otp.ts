import type { FastifyBaseLogger } from "fastify";
import type { Db } from "../db.ts";
import { HttpError } from "../lib/errors.ts";
import { maskPhone } from "../lib/phone.ts";
import { otpCode, type Sealer, safeEqualHex } from "./crypto.ts";

export type OtpPurpose = "register" | "reset" | "admin";

/** Delivers one-time codes. In production: the admin's WhatsApp (Baileys). */
export interface OtpSender {
  isReady(): boolean;
  /** Resolves false when the number has no WhatsApp account. */
  hasWhatsApp(phone: string): Promise<boolean>;
  sendText(phone: string, text: string): Promise<void>;
}

export const OTP_TTL_MS = 5 * 60 * 1000;
export const OTP_RESEND_MS = 60 * 1000;
const MAX_PER_PHONE_HOUR = 5;
const MAX_PER_IP_HOUR = 15;
const MAX_ATTEMPTS = 5;

const TEXTS: Record<OtpPurpose, (code: string) => string> = {
  register: (c) =>
    `*Alma AI*\nВаш код подтверждения: *${c}*\n\nКод действует 5 минут. Никому его не сообщайте.`,
  reset: (c) =>
    `*Alma AI*\nКод для восстановления пароля: *${c}*\n\nЕсли вы не запрашивали код — просто проигнорируйте это сообщение.`,
  admin: (c) => `*Alma AI · админ-панель*\nКод входа: *${c}*`,
};

export class OtpService {
  private readonly db: Db;
  private readonly sealer: Sealer;
  private readonly sender: OtpSender;
  private readonly log: FastifyBaseLogger;
  private readonly devLog: boolean;

  constructor(opts: {
    db: Db;
    sealer: Sealer;
    sender: OtpSender;
    log: FastifyBaseLogger;
    devLog: boolean;
  }) {
    this.db = opts.db;
    this.sealer = opts.sealer;
    this.sender = opts.sender;
    this.log = opts.log;
    this.devLog = opts.devLog;
  }

  private hash(phone: string, purpose: OtpPurpose, code: string): string {
    return this.sealer.mac(`${purpose}:${phone}:${code}`);
  }

  /** Throws HttpError(429) with `retry_after` seconds when limited. */
  private enforceLimits(phone: string, purpose: OtpPurpose, ip: string) {
    const now = Date.now();
    const last = this.db.get<{ created_at: number }>(
      "SELECT created_at FROM otp_codes WHERE phone = ? AND purpose = ? ORDER BY created_at DESC LIMIT 1",
      phone,
      purpose,
    );
    if (last && now - last.created_at < OTP_RESEND_MS) {
      const retry = Math.ceil((OTP_RESEND_MS - (now - last.created_at)) / 1000);
      throw new HttpError(429, "otp_too_soon", `Повторно отправить код можно через ${retry} с`, {
        retry_after: retry,
      });
    }
    const perPhone = this.db.get<{ n: number }>(
      "SELECT COUNT(*) AS n FROM otp_codes WHERE phone = ? AND created_at > ?",
      phone,
      now - 3600_000,
    );
    const perIp = this.db.get<{ n: number }>(
      "SELECT COUNT(*) AS n FROM otp_codes WHERE ip = ? AND created_at > ?",
      ip,
      now - 3600_000,
    );
    if ((perPhone?.n ?? 0) >= MAX_PER_PHONE_HOUR || (perIp?.n ?? 0) >= MAX_PER_IP_HOUR) {
      throw new HttpError(429, "otp_limit", "Слишком много запросов кода. Попробуйте через час.", {
        retry_after: 3600,
      });
    }
  }

  async issue(opts: {
    phone: string;
    purpose: OtpPurpose;
    ip: string;
    payload?: Record<string, unknown>;
    /** For flows that must not reveal whether an account exists. */
    silent?: boolean;
  }): Promise<{ expires_in: number; resend_in: number }> {
    const { phone, purpose, ip } = opts;
    this.enforceLimits(phone, purpose, ip);

    const devFallback = this.devLog && !this.sender.isReady();
    if (!devFallback && !this.sender.isReady()) {
      throw new HttpError(
        503,
        "otp_unavailable",
        "Сервис подтверждения временно недоступен. Попробуйте позже.",
      );
    }

    const code = otpCode();
    const now = Date.now();
    const id = this.db.tx(() => {
      this.db.run(
        "UPDATE otp_codes SET consumed_at = ?, payload = NULL WHERE phone = ? AND purpose = ? AND consumed_at IS NULL",
        now,
        phone,
        purpose,
      );
      return this.db.run(
        `INSERT INTO otp_codes (phone, purpose, code_hash, payload, ip, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        phone,
        purpose,
        this.hash(phone, purpose, code),
        opts.payload ? JSON.stringify(opts.payload) : null,
        ip,
        now,
        now + OTP_TTL_MS,
      ).lastInsertRowid;
    });

    if (opts.silent) {
      // Caller already decided the account does not exist; the row above
      // keeps rate limits identical, but nothing is sent.
      this.db.run("UPDATE otp_codes SET consumed_at = ?, payload = NULL WHERE id = ?", now, id);
    } else if (devFallback) {
      this.log.warn({ phone: maskPhone(phone), purpose, code }, "DEV OTP (sender not connected)");
    } else {
      try {
        if (!(await this.sender.hasWhatsApp(phone))) {
          this.db.run("UPDATE otp_codes SET consumed_at = ?, payload = NULL WHERE id = ?", now, id);
          throw new HttpError(400, "no_whatsapp", "На этом номере нет WhatsApp");
        }
        await this.sender.sendText(phone, TEXTS[purpose](code));
      } catch (err) {
        this.db.run("UPDATE otp_codes SET consumed_at = ?, payload = NULL WHERE id = ?", now, id);
        if (err instanceof HttpError) throw err;
        this.log.error({ err, phone: maskPhone(phone) }, "OTP delivery failed");
        throw new HttpError(503, "otp_unavailable", "Не удалось отправить код. Попробуйте позже.");
      }
    }
    return { expires_in: OTP_TTL_MS / 1000, resend_in: OTP_RESEND_MS / 1000 };
  }

  /** Returns the stored payload on success; consumes the code. */
  verify(phone: string, purpose: OtpPurpose, code: string): Record<string, unknown> {
    const invalid = new HttpError(400, "otp_invalid", "Неверный или просроченный код");
    if (!/^\d{6}$/.test(code)) throw invalid;
    const row = this.db.get<{ id: number; code_hash: string; attempts: number; payload: string | null }>(
      `SELECT id, code_hash, attempts, payload FROM otp_codes
        WHERE phone = ? AND purpose = ? AND consumed_at IS NULL AND expires_at > ?
        ORDER BY created_at DESC LIMIT 1`,
      phone,
      purpose,
      Date.now(),
    );
    if (!row || row.attempts >= MAX_ATTEMPTS) throw invalid;
    if (!safeEqualHex(row.code_hash, this.hash(phone, purpose, code))) {
      this.db.run("UPDATE otp_codes SET attempts = attempts + 1 WHERE id = ?", row.id);
      throw invalid;
    }
    const consumed = this.db.run(
      "UPDATE otp_codes SET consumed_at = ?, payload = NULL WHERE id = ? AND consumed_at IS NULL",
      Date.now(),
      row.id,
    );
    if (consumed.changes !== 1) throw invalid; // lost a race with a parallel verify
    return row.payload ? (JSON.parse(row.payload) as Record<string, unknown>) : {};
  }
}
