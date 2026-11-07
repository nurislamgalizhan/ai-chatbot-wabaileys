import type { FastifyBaseLogger } from "fastify";
import type { KnowledgeBase } from "./ai/kb.ts";
import type { Ai } from "./ai/openai.ts";
import type { Responder } from "./ai/responder.ts";
import type { Config } from "./config.ts";
import type { Db } from "./db.ts";
import type { AdminAuth } from "./security/admin.ts";
import type { OtpService } from "./security/otp.ts";
import type { Inbound } from "./wa/inbound.ts";
import type { WaManager } from "./wa/manager.ts";
import type { MediaStore } from "./wa/media.ts";

/** Everything a route needs, built once in index.ts (or a test). */
export interface Ctx {
  cfg: Config;
  db: Db;
  log: FastifyBaseLogger;
  wa: WaManager;
  ai: Ai;
  kb: KnowledgeBase;
  responder: Responder;
  otp: OtpService;
  media: MediaStore;
  inbound: Inbound;
  adminAuth: AdminAuth;
}
