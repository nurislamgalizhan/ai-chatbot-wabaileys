import { randomInt } from "node:crypto";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "../config.ts";
import { normalizePhone } from "../lib/phone.ts";
import { hashPassword, safeEqualHex, type Sealer, verifyPassword } from "./crypto.ts";

const RECOVERY_TTL_MS = 15 * 60_000;
const RECOVERY_MAX_ATTEMPTS = 5;
export const RECOVERY_FILE = "admin-recovery-code.txt";

/** ADMIN_PASSWORD_HASH is stored as "argon2id:<base64url(PHC)>" — no "$"
 *  characters, so it survives .env / docker-compose interpolation. */
export function encodeAdminHash(phc: string): string {
  return `argon2id:${Buffer.from(phc, "utf8").toString("base64url")}`;
}

export function decodeAdminHash(value: string): string | null {
  const v = value.trim();
  const phc = v.startsWith("argon2id:") ? Buffer.from(v.slice(9), "base64url").toString("utf8") : v;
  return /^\$argon2id\$v=19\$m=\d+,t=\d+,p=\d+\$[^$]+\$[^$]+$/.test(phc) ? phc : null;
}

/**
 * The platform owner's credentials. Login is ALWAYS two-step:
 *   1. password (Argon2id),
 *   2. a one-time code — sent to ADMIN_PHONE in WhatsApp, or a recovery
 *      code written to a file in DATA_DIR (needs shell access to the
 *      server). The password alone never opens the admin area.
 */
export class AdminAuth {
  private readonly cfg: Config;
  private readonly sealer: Sealer;
  private phc: Promise<string> | null = null;
  private recovery: { hash: string; expires: number; attempts: number } | null = null;

  constructor(cfg: Config, sealer: Sealer) {
    this.cfg = cfg;
    this.sealer = sealer;
    if (cfg.ADMIN_PASSWORD_HASH && !decodeAdminHash(cfg.ADMIN_PASSWORD_HASH)) {
      throw new Error("ADMIN_PASSWORD_HASH is malformed — generate it with `npm run admin:hash`");
    }
  }

  /** The admin signs in at /login with this number. */
  get phone(): string | null {
    return this.cfg.ADMIN_PHONE ? normalizePhone(this.cfg.ADMIN_PHONE) : null;
  }

  get configured(): boolean {
    return Boolean((this.cfg.ADMIN_PASSWORD_HASH || this.cfg.ADMIN_PASSWORD) && this.phone);
  }

  private credential(): Promise<string> {
    if (!this.phc) {
      const stored = this.cfg.ADMIN_PASSWORD_HASH ? decodeAdminHash(this.cfg.ADMIN_PASSWORD_HASH) : null;
      // A plain ADMIN_PASSWORD is hashed once, so every check costs the same.
      this.phc = stored ? Promise.resolve(stored) : hashPassword(this.cfg.ADMIN_PASSWORD ?? "");
    }
    return this.phc;
  }

  async verifyPassword(password: string): Promise<boolean> {
    if (!this.configured) return false;
    return verifyPassword(password, await this.credential());
  }

  /** Changes whenever the admin password changes: older sessions die. */
  fingerprint(): string {
    return this.sealer.mac(`admin-credential:${this.cfg.ADMIN_PASSWORD_HASH ?? this.cfg.ADMIN_PASSWORD ?? ""}`);
  }

  /** Writes a fresh 10-digit code to DATA_DIR (mode 0600). */
  issueRecoveryCode(): string {
    const code = Array.from({ length: 10 }, () => randomInt(0, 10)).join("");
    this.recovery = { hash: this.sealer.mac(`recovery:${code}`), expires: Date.now() + RECOVERY_TTL_MS, attempts: 0 };
    const path = join(this.cfg.DATA_DIR, RECOVERY_FILE);
    writeFileSync(
      path,
      `${code}\n\nКод восстановления для входа в админ-панель Alma AI.\nДействует 15 минут, одноразовый. Файл удалится после входа.\n`,
      { mode: 0o600 },
    );
    return path;
  }

  verifyRecoveryCode(code: string): boolean {
    const r = this.recovery;
    if (!r || r.expires <= Date.now() || r.attempts >= RECOVERY_MAX_ATTEMPTS || !/^\d{10}$/.test(code)) {
      return false;
    }
    if (!safeEqualHex(r.hash, this.sealer.mac(`recovery:${code}`))) {
      r.attempts += 1;
      return false;
    }
    this.clearRecovery();
    return true;
  }

  clearRecovery() {
    this.recovery = null;
    rmSync(join(this.cfg.DATA_DIR, RECOVERY_FILE), { force: true });
  }
}
