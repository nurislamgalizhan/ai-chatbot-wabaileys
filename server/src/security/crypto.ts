import {
  argon2,
  createCipheriv,
  createDecipheriv,
  createHash,
  hkdfSync,
  randomBytes,
  randomInt,
  timingSafeEqual,
} from "node:crypto";

/* ---------- Passwords: Argon2id (built into Node >= 24.7) ---------- */

// OWASP-recommended Argon2id baseline: m=19 MiB, t=2, p=1.
interface ArgonParams {
  memory: number;
  passes: number;
  parallelism: number;
  tagLength: number;
}
const ARGON: ArgonParams = { memory: 19_456, passes: 2, parallelism: 1, tagLength: 32 };

function argon2id(message: string, nonce: Buffer, params: ArgonParams = ARGON): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    argon2("argon2id", { message, nonce, ...params }, (err, key) =>
      err ? reject(err) : resolve(key),
    );
  });
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await argon2id(password, salt);
  return `$argon2id$v=19$m=${ARGON.memory},t=${ARGON.passes},p=${ARGON.parallelism}$${salt.toString("base64")}$${hash.toString("base64")}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const m = /^\$argon2id\$v=19\$m=(\d+),t=(\d+),p=(\d+)\$([^$]+)\$([^$]+)$/.exec(stored);
  if (!m) return false;
  const [, mem, passes, par, saltB64, hashB64] = m;
  const expected = Buffer.from(hashB64!, "base64");
  const actual = await argon2id(password, Buffer.from(saltB64!, "base64"), {
    memory: Number(mem),
    passes: Number(passes),
    parallelism: Number(par),
    tagLength: expected.length,
  });
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/** A real hash of a random password: verifying against it costs the same
 *  as a real account, so login timing does not reveal unknown phones. */
let dummyHash: Promise<string> | null = null;
export function dummyPasswordHash(): Promise<string> {
  dummyHash ??= hashPassword(randomBytes(16).toString("hex"));
  return dummyHash;
}

/* ---------- Tokens and codes ---------- */

export const sha256 = (value: string): string =>
  createHash("sha256").update(value).digest("hex");

export const randomToken = (bytes = 32): string => randomBytes(bytes).toString("base64url");

export function otpCode(): string {
  return randomInt(0, 1_000_000).toString().padStart(6, "0");
}

export function safeEqualHex(a: string, b: string): boolean {
  const ab = Buffer.from(a, "hex");
  const bb = Buffer.from(b, "hex");
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

/* ---------- Encryption at rest (AES-256-GCM) ---------- */

export class Sealer {
  private readonly key: Buffer;

  constructor(secret: string, purpose: string) {
    this.key = Buffer.from(hkdfSync("sha256", secret, "alma-ai", purpose, 32));
  }

  /** OTP codes are hashed with a keyed hash so a DB leak alone does not
   *  allow brute-forcing the 10^6 space offline. */
  mac(value: string): string {
    return createHash("sha256").update(this.key).update(value).digest("hex");
  }

  seal(plain: Buffer): Buffer {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    const body = Buffer.concat([cipher.update(plain), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), body]);
  }

  open(sealed: Uint8Array): Buffer {
    const buf = Buffer.from(sealed);
    const decipher = createDecipheriv("aes-256-gcm", this.key, buf.subarray(0, 12));
    decipher.setAuthTag(buf.subarray(12, 28));
    return Buffer.concat([decipher.update(buf.subarray(28)), decipher.final()]);
  }
}
