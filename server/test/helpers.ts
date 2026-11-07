import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WAMessage, WASocket } from "baileys";
import type { FastifyInstance } from "fastify";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import { pino } from "pino";
import { KnowledgeBase } from "../src/ai/kb.ts";
import type { Ai } from "../src/ai/openai.ts";
import { Responder } from "../src/ai/responder.ts";
import { buildApp } from "../src/app.ts";
import { loadConfig } from "../src/config.ts";
import type { Ctx } from "../src/context.ts";
import { Db } from "../src/db.ts";
import { AdminAuth } from "../src/security/admin.ts";
import { Sealer } from "../src/security/crypto.ts";
import { OtpService, type OtpSender } from "../src/security/otp.ts";
import { Inbound } from "../src/wa/inbound.ts";
import type { WaManager } from "../src/wa/manager.ts";
import { MediaStore } from "../src/wa/media.ts";

export const ORIGIN = "http://localhost:5173";
export const ADMIN_PHONE = "77009998877";
export const ADMIN_PASSWORD = "admin-password-12";

/** Tiny valid file headers, so content sniffing has something real. */
export const FAKE_JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(200, 1)]);
export const FAKE_OGG = Buffer.concat([Buffer.from("OggS"), Buffer.alloc(200, 2)]);
export const FAKE_HTML = Buffer.from("<html><script>alert(1)</script></html>");

/** WhatsApp stand-in: records what would have been sent. */
export class FakeWa {
  sent: { session: string; jid: string; text: string; id: string }[] = [];
  connected = new Set<string>();
  historyRequests: unknown[] = [];
  private n = 0;
  isConnected = (s: string) => this.connected.has(s);
  newMessageId = () => `BOT${++this.n}`;
  typing = async () => {};
  sendText = async (session: string, jid: string, text: string, id?: string) => {
    const mid = id ?? `X${++this.n}`;
    this.sent.push({ session, jid, text, id: mid });
    return mid;
  };
  view = () => ({ status: "disconnected", qr: null, pairing_code: null, phone: null, name: null, connected_at: null, last_error: null });
  logout = async () => {};
  link = async () => {};
  cancel = async () => {};
  socket = (s: string) => (this.connected.has(s) ? ({ user: { id: "77070000000:1@s.whatsapp.net" } } as unknown as WASocket) : null);
  requestHistory = async (...args: unknown[]) => {
    this.historyRequests.push(args);
  };
}

export class FakeAi {
  calls = 0;
  lastMessages: ChatCompletionMessageParam[] = [];
  reply = "Здравствуйте! Чем помочь?";
  handoff = false;
  enabled = true;
  transcript = "Сколько стоит абонемент?";
  transcribeCalls = 0;
  modelFor = () => "test-model";
  replyFn = async (_model: string, messages: ChatCompletionMessageParam[]) => {
    this.calls++;
    this.lastMessages = messages;
    return { reply: this.reply, handoff: this.handoff, model: "test-model", tokensIn: 10, tokensOut: 5 };
  };
  embed = async (t: string[]) => t.map(() => new Float32Array([1, 0, 0]));
  transcribe = async () => {
    this.transcribeCalls++;
    return this.transcript;
  };
}

/** Media store whose "WhatsApp download" returns canned bytes. */
class FakeMediaStore extends MediaStore {
  next: Buffer = FAKE_JPEG;
  override async download(_sock: WASocket, _msg: WAMessage): Promise<Buffer> {
    return this.next;
  }
}

export interface TestEnv {
  app: FastifyInstance;
  ctx: Ctx;
  wa: FakeWa;
  ai: FakeAi;
  media: FakeMediaStore;
  codes: { phone: string; text: string }[];
  inbound: Inbound;
  dir: string;
  close: () => Promise<void>;
}

export async function makeEnv(opts: { historyDays?: number } = {}): Promise<TestEnv> {
  const dir = mkdtempSync(join(tmpdir(), "alma-test-"));
  const cfg = loadConfig({
    NODE_ENV: "test",
    DATA_DIR: dir,
    APP_SECRET: "x".repeat(40),
    APP_ORIGIN: ORIGIN,
    ADMIN_PASSWORD,
    ADMIN_PHONE,
    WEB_DIST: join(dir, "no-web"),
  });
  const log = pino({ level: "silent" });
  const db = new Db(cfg.dbPath);
  const wa = new FakeWa();
  const fakeAi = new FakeAi();
  const ai = {
    get enabled() {
      return fakeAi.enabled;
    },
    modelFor: fakeAi.modelFor,
    reply: fakeAi.replyFn,
    embed: fakeAi.embed,
    transcribe: fakeAi.transcribe,
  } as unknown as Ai;
  const codes: { phone: string; text: string }[] = [];
  const sender: OtpSender = {
    isReady: () => true,
    hasWhatsApp: async () => true,
    sendText: async (phone, text) => {
      codes.push({ phone, text });
    },
  };
  const kb = new KnowledgeBase(db, ai, log);
  const media = new FakeMediaStore({ dataDir: dir, sealer: new Sealer(cfg.appSecret, "media-ref-v1"), log, maxMb: 5 });
  const responder = new Responder({ db, wa: wa as unknown as WaManager, ai, kb, log });
  const otp = new OtpService({ db, sealer: new Sealer(cfg.appSecret, "otp-v1"), sender, log, devLog: false });
  const adminAuth = new AdminAuth(cfg, new Sealer(cfg.appSecret, "admin-v1"));
  const inbound = new Inbound({ db, ai, responder, media, log, historyDays: opts.historyDays ?? 60 });
  const ctx: Ctx = { cfg, db, log, wa: wa as unknown as WaManager, ai, kb, responder, otp, media, inbound, adminAuth };
  const app = await buildApp(ctx);
  return {
    app,
    ctx,
    wa,
    ai: fakeAi,
    media,
    codes,
    inbound,
    dir,
    close: async () => {
      responder.shutdown();
      await app.close();
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

export const lastCode = (env: TestEnv) => /\*(\d{6})\*/.exec(env.codes.at(-1)?.text ?? "")?.[1] ?? "";

export function cookieFrom(res: { headers: Record<string, unknown> }, name = "alma_sid"): string {
  const raw = res.headers["set-cookie"];
  const list = (Array.isArray(raw) ? raw : [raw]).filter((x): x is string => typeof x === "string");
  const c = list.filter((x) => x.startsWith(`${name}=`)).at(-1);
  return c ? c.split(";")[0]! : "";
}

export async function registerUser(env: TestEnv, phone: string, name = "Тест"): Promise<string> {
  const start = await env.app.inject({
    method: "POST",
    url: "/api/auth/register/start",
    headers: { origin: ORIGIN },
    payload: { name, company: "ТОО", phone, password: "password-123" },
  });
  if (start.statusCode !== 200) throw new Error(`register/start ${start.statusCode} ${start.body}`);
  const verify = await env.app.inject({
    method: "POST",
    url: "/api/auth/register/verify",
    headers: { origin: ORIGIN },
    payload: { phone, code: lastCode(env) },
  });
  if (verify.statusCode !== 200) throw new Error(`register/verify ${verify.statusCode} ${verify.body}`);
  return cookieFrom(verify);
}

/** Full two-factor admin login via the ordinary /login; returns the admin cookie. */
export async function adminLogin(env: TestEnv): Promise<string> {
  env.wa.connected.add("system");
  env.ctx.db.run("DELETE FROM otp_codes WHERE phone = ?", ADMIN_PHONE); // test only: skip the 60 s resend wait
  const pw = await env.app.inject({
    method: "POST",
    url: "/api/auth/login",
    headers: { origin: ORIGIN },
    payload: { phone: ADMIN_PHONE, password: ADMIN_PASSWORD },
  });
  if (pw.statusCode !== 200) throw new Error(`auth/login (admin) ${pw.statusCode} ${pw.body}`);
  const pending = cookieFrom(pw, "alma_2fa");
  const v = await env.app.inject({
    method: "POST",
    url: "/api/auth/2fa/verify",
    headers: { origin: ORIGIN, cookie: pending },
    payload: { method: "whatsapp", code: lastCode(env) },
  });
  if (v.statusCode !== 200) throw new Error(`admin/verify ${v.statusCode} ${v.body}`);
  return cookieFrom(v, "alma_admin");
}

export function grantAccess(env: TestEnv, phone: string, days = 30) {
  env.ctx.db.run("UPDATE users SET ai_access_until = ? WHERE phone = ?", Date.now() + days * 86400_000, phone);
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
