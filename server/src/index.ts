import { pino } from "pino";
import { KnowledgeBase } from "./ai/kb.ts";
import { Ai } from "./ai/openai.ts";
import { Responder } from "./ai/responder.ts";
import { buildApp } from "./app.ts";
import { loadConfig } from "./config.ts";
import type { Ctx } from "./context.ts";
import { Db } from "./db.ts";
import { AdminAuth } from "./security/admin.ts";
import { Sealer } from "./security/crypto.ts";
import { OtpService } from "./security/otp.ts";
import { purgeExpiredSessions } from "./security/sessions.ts";
import { sendAccessNotices } from "./services/access.ts";
import { purgeCheckSessions } from "./services/check.ts";
import { Inbound } from "./wa/inbound.ts";
import { WaManager } from "./wa/manager.ts";
import { MediaStore } from "./wa/media.ts";
import { waOtpSender } from "./wa/otpSender.ts";

const cfg = loadConfig();

const log = pino({
  level: cfg.LOG_LEVEL,
  // Belt and braces: none of these should ever reach a log line.
  redact: {
    paths: [
      "req.headers.cookie",
      "req.headers.authorization",
      "res.headers['set-cookie']",
      "*.password",
      "*.password_hash",
      "*.code",
    ],
    censor: "[redacted]",
  },
  ...(cfg.isProd ? {} : { transport: { target: "pino-pretty", options: { translateTime: "HH:MM:ss", ignore: "pid,hostname" } } }),
});

const db = new Db(cfg.dbPath);
const wa = new WaManager(db, new Sealer(cfg.appSecret, "wa-auth-v1"), log);
const ai = new Ai(cfg);
const kb = new KnowledgeBase(db, ai, log);
const media = new MediaStore({ dataDir: cfg.DATA_DIR, sealer: new Sealer(cfg.appSecret, "media-ref-v1"), log, maxMb: cfg.MEDIA_MAX_MB });
const responder = new Responder({ db, wa, ai, kb, log });
const otp = new OtpService({
  db,
  sealer: new Sealer(cfg.appSecret, "otp-v1"),
  sender: waOtpSender(wa),
  log,
  devLog: cfg.OTP_DEV_LOG,
});
const adminAuth = new AdminAuth(cfg, new Sealer(cfg.appSecret, "admin-v1"));
const inbound = new Inbound({ db, ai, responder, media, log, historyDays: cfg.HISTORY_DAYS });
wa.onUpsert = inbound.handle;
wa.onHistory = inbound.handleHistory;
wa.onUpdate = inbound.handleUpdate;
wa.onCall = inbound.handleCall;

const ctx: Ctx = { cfg, db, log, wa, ai, kb, responder, otp, media, inbound, adminAuth };
const app = await buildApp(ctx);

if (!cfg.OPENAI_API_KEY) log.warn("OPENAI_API_KEY is not set — the bot will not answer customers");
if (!adminAuth.configured) log.warn("ADMIN_PASSWORD_HASH / ADMIN_PASSWORD not set — /admin is disabled");
if (cfg.isProd && cfg.ADMIN_PASSWORD && !cfg.ADMIN_PASSWORD_HASH) {
  log.warn("ADMIN_PASSWORD is stored in plain text — prefer ADMIN_PASSWORD_HASH (npm run admin:hash)");
}

await app.listen({ host: cfg.HOST, port: cfg.PORT });
await wa.restoreAll();

// Entries saved while the process was down (or whose embedding failed).
for (const row of db.all<{ id: number; user_id: number }>("SELECT id, user_id FROM kb_entries WHERE index_state <> 'ready'")) {
  void kb.index(row.user_id, row.id).catch((err) => log.warn({ err }, "kb reindex failed"));
}

/** Media older than MEDIA_RETENTION_DAYS is deleted from disk. */
function expireMedia() {
  const cutoff = Date.now() - cfg.MEDIA_RETENTION_DAYS * 24 * 3600_000;
  const rows = db.all<{ id: number; user_id: number; media_file: string | null }>(
    "SELECT id, user_id, media_file FROM messages WHERE media_state = 'stored' AND created_at < ? LIMIT 1000",
    cutoff,
  );
  for (const r of rows) {
    media.remove(r.user_id, r.media_file);
    db.run("UPDATE messages SET media_state = 'expired', media_file = NULL, media_ref = NULL WHERE id = ?", r.id);
  }
  if (rows.length) log.info({ files: rows.length }, "expired media removed");
}

async function hourly() {
  try {
    purgeExpiredSessions(db);
    purgeCheckSessions(db);
    expireMedia();
    await sendAccessNotices(db, wa, log, cfg.SUPPORT_WHATSAPP);
  } catch (err) {
    log.error({ err }, "hourly job failed");
  }
}
setTimeout(() => void hourly(), 60_000).unref(); // after WhatsApp sessions settle
setInterval(() => void hourly(), 3600_000).unref();

let closing = false;
async function shutdown(signal: string) {
  if (closing) return;
  closing = true;
  log.info({ signal }, "shutting down");
  responder.shutdown();
  await app.close().catch(() => undefined);
  await wa.shutdown().catch(() => undefined);
  db.close();
  process.exit(0);
}
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
