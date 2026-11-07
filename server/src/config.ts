import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

const here = dirname(fileURLToPath(import.meta.url));

const boolish = z
  .enum(["true", "false", "1", "0", "yes", "no", ""])
  .optional()
  .transform((v) => v === "true" || v === "1" || v === "yes");

const EnvSchema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  HOST: z.string().default("0.0.0.0"),
  PORT: z.coerce.number().int().min(1).max(65535).default(4100),
  /** Public origin of the app (app.<domain>.kz). Used for CSRF origin checks. */
  APP_ORIGIN: z.string().url().default("http://localhost:5173"),
  /** Chief's read-only view (check.<domain>.kz). */
  CHECK_ORIGIN: z.string().url().default("http://check.localhost:5173"),
  /** Extra comma separated origins allowed to call the API (dev tooling). */
  EXTRA_ORIGINS: z.string().default(""),
  DATA_DIR: z.string().default(join(here, "..", "data")),
  WEB_DIST: z.string().default(join(here, "..", "..", "web", "dist")),
  /** Encrypts WhatsApp session keys at rest. 32+ random chars. */
  APP_SECRET: z.string().optional(),
  TRUST_PROXY: z.string().default("loopback,uniquelocal"),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),

  /** Plain admin password (min 12 chars). Prefer ADMIN_PASSWORD_HASH. */
  ADMIN_PASSWORD: z.string().optional(),
  /** Argon2id hash from `npm run admin:hash` — keeps the password out of .env. */
  ADMIN_PASSWORD_HASH: z.string().optional(),
  /** Admin's WhatsApp: the second login factor (code sent from the OTP sender). */
  ADMIN_PHONE: z.string().optional(),
  /** Shown to clients as "contact us to extend AI access" (digits, e.g. 77001234567). */
  SUPPORT_WHATSAPP: z.string().optional(),
  /** Free AI days for new sign-ups; 0 = access only after the admin grants it. */
  AI_TRIAL_DAYS: z.coerce.number().int().min(0).max(365).default(0),

  MEDIA_MAX_MB: z.coerce.number().int().min(1).max(100).default(25),
  MEDIA_RETENTION_DAYS: z.coerce.number().int().min(1).max(3650).default(180),
  /** How far back chat history is imported when a number is linked;
   *  0 = everything the phone sends (full history). */
  HISTORY_DAYS: z.coerce.number().int().min(0).max(3650).default(0),

  OPENAI_API_KEY: z.string().optional(),
  OPENAI_BASE_URL: z.string().url().optional(),
  OPENAI_MODEL: z.string().default("gpt-5.4-mini"),
  OPENAI_MODEL_QUALITY: z.string().default("gpt-5.4"),
  OPENAI_REASONING_EFFORT: z.enum(["", "none", "minimal", "low", "medium", "high"]).default(""),
  OPENAI_EMBEDDING_MODEL: z.string().default("text-embedding-3-small"),
  OPENAI_TRANSCRIBE_MODEL: z.string().default("gpt-transcribe"),

  /** Development only: print OTP codes to the server log when the
   *  WhatsApp sender is not connected. Ignored in production. */
  OTP_DEV_LOG: boolish,
});

export type Config = z.infer<typeof EnvSchema> & {
  appSecret: string;
  allowedOrigins: Set<string>;
  checkHost: string;
  isProd: boolean;
  dbPath: string;
};

function loadAppSecret(env: z.infer<typeof EnvSchema>): string {
  if (env.APP_SECRET) {
    if (env.APP_SECRET.length < 32) {
      throw new Error("APP_SECRET must be at least 32 characters");
    }
    return env.APP_SECRET;
  }
  if (env.NODE_ENV === "production") {
    throw new Error("APP_SECRET is required in production (openssl rand -hex 32)");
  }
  // Dev/test convenience: a generated secret persisted next to the database.
  const file = join(env.DATA_DIR, ".dev-secret");
  if (existsSync(file)) return readFileSync(file, "utf8").trim();
  mkdirSync(env.DATA_DIR, { recursive: true });
  const secret = randomBytes(32).toString("hex");
  writeFileSync(file, secret, { mode: 0o600 });
  chmodSync(file, 0o600);
  return secret;
}

export function loadConfig(source: NodeJS.ProcessEnv = process.env): Config {
  // `KEY=` in an .env file means "not set", so defaults still apply.
  const cleaned = Object.fromEntries(Object.entries(source).filter(([, v]) => v !== undefined && v !== ""));
  const parsed = EnvSchema.safeParse(cleaned);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`);
    throw new Error(`Invalid environment:\n${issues.join("\n")}`);
  }
  const env = parsed.data;
  const isProd = env.NODE_ENV === "production";
  if (isProd && env.ADMIN_PASSWORD && env.ADMIN_PASSWORD.length < 12) {
    throw new Error("ADMIN_PASSWORD must be at least 12 characters");
  }
  const allowedOrigins = new Set<string>([new URL(env.APP_ORIGIN).origin, new URL(env.CHECK_ORIGIN).origin]);
  for (const raw of env.EXTRA_ORIGINS.split(",").map((s) => s.trim()).filter(Boolean)) {
    allowedOrigins.add(new URL(raw).origin);
  }
  const dataDir = resolve(env.DATA_DIR);
  mkdirSync(dataDir, { recursive: true });
  return {
    ...env,
    DATA_DIR: dataDir,
    OTP_DEV_LOG: env.OTP_DEV_LOG && !isProd,
    appSecret: loadAppSecret({ ...env, DATA_DIR: dataDir }),
    allowedOrigins,
    checkHost: new URL(env.CHECK_ORIGIN).hostname,
    isProd,
    dbPath: join(dataDir, "alma.db"),
  };
}
