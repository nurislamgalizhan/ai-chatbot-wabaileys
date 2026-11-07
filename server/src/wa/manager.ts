import makeWASocket, {
  type BaileysEventMap,
  Browsers,
  DisconnectReason,
  fetchLatestBaileysVersion,
  generateMessageIDV2,
  isJidBroadcast,
  isJidGroup,
  isJidNewsletter,
  jidDecode,
  makeCacheableSignalKeyStore,
  type proto,
  type WASocket,
} from "baileys";
import type { FastifyBaseLogger } from "fastify";
import { pino } from "pino";
import QRCode from "qrcode";
import type { Db } from "../db.ts";
import { HttpError } from "../lib/errors.ts";
import { maskPhone } from "../lib/phone.ts";
import type { Sealer } from "../security/crypto.ts";
import { hasRegisteredCreds, useDbAuthState, wipeAuthState } from "./authState.ts";

export type WaStatus = "disconnected" | "connecting" | "qr" | "pairing" | "connected";
export type LinkMethod = "qr" | "code";

export const SYSTEM_SESSION = "system";
export const userSessionId = (userId: number) => `u:${userId}`;

export interface WaStatusView {
  status: WaStatus;
  qr: string | null;
  pairing_code: string | null;
  phone: string | null;
  name: string | null;
  connected_at: number | null;
  last_error: string | null;
}

interface Live {
  id: string;
  userId: number | null;
  sock: WASocket | null;
  status: WaStatus;
  method: LinkMethod;
  pairingPhone: string | null;
  pairingRequested: boolean;
  qr: string | null;
  pairingCode: string | null;
  qrShown: number;
  lastPolled: number;
  retries: number;
  stopping: boolean;
  reconnectTimer: NodeJS.Timeout | null;
  /** Recently sent messages, for Baileys retry receipts (getMessage). */
  sent: Map<string, proto.IMessage>;
  lastError: string | null;
}

type SessionRef = { id: string; userId: number; sock: WASocket };
export type UpdateHandler = (session: SessionRef, updates: BaileysEventMap["messages.update"]) => void | Promise<void>;
export type CallHandler = (session: SessionRef, calls: BaileysEventMap["call"]) => void | Promise<void>;

export type HistoryHandler = (
  session: { id: string; userId: number; sock: WASocket },
  event: BaileysEventMap["messaging-history.set"],
) => void | Promise<void>;

export type UpsertHandler = (
  session: { id: string; userId: number; sock: WASocket },
  event: BaileysEventMap["messages.upsert"],
) => void | Promise<void>;

const LINK_IDLE_MS = 90_000; // stop showing a QR nobody is looking at
const MAX_QR_ROTATIONS = 8;
const SENT_CACHE = 300;

let versionCache: { at: number; version: [number, number, number] } | null = null;
async function waVersion(): Promise<[number, number, number] | undefined> {
  if (versionCache && Date.now() - versionCache.at < 6 * 3600_000) return versionCache.version;
  try {
    const { version } = await fetchLatestBaileysVersion();
    versionCache = { at: Date.now(), version };
    return version;
  } catch {
    return versionCache?.version; // Baileys falls back to its bundled version
  }
}

export class WaManager {
  private readonly db: Db;
  private readonly sealer: Sealer;
  private readonly log: FastifyBaseLogger;
  private readonly baileysLog = pino({ level: process.env.BAILEYS_LOG_LEVEL ?? "error" });
  private readonly live = new Map<string, Live>();
  private sweeper: NodeJS.Timeout | null = null;
  onUpsert: UpsertHandler | null = null;
  onHistory: HistoryHandler | null = null;
  onUpdate: UpdateHandler | null = null;
  onCall: CallHandler | null = null;
  onStatus: ((sessionId: string, status: WaStatus) => void) | null = null;

  constructor(db: Db, sealer: Sealer, log: FastifyBaseLogger) {
    this.db = db;
    this.sealer = sealer;
    this.log = log;
  }

  /* ---------- lifecycle ---------- */

  async restoreAll(): Promise<void> {
    const rows = this.db.all<{ session_id: string; user_id: number | null }>(
      "SELECT session_id, user_id FROM wa_connections WHERE enabled = 1",
    );
    for (const row of rows) {
      if (!hasRegisteredCreds(this.db, this.sealer, row.session_id)) {
        this.persist(row.session_id, row.user_id, { enabled: 0, status: "disconnected" });
        continue;
      }
      const live = this.ensure(row.session_id, row.user_id);
      void this.start(live);
    }
    this.sweeper = setInterval(() => this.sweep(), 15_000);
    this.sweeper.unref();
  }

  async shutdown(): Promise<void> {
    if (this.sweeper) clearInterval(this.sweeper);
    for (const live of this.live.values()) {
      live.stopping = true;
      if (live.reconnectTimer) clearTimeout(live.reconnectTimer);
      try {
        live.sock?.end(undefined);
      } catch {
        /* closing anyway */
      }
    }
  }

  private ensure(id: string, userId: number | null): Live {
    let live = this.live.get(id);
    if (!live) {
      live = {
        id,
        userId,
        sock: null,
        status: "disconnected",
        method: "qr",
        pairingPhone: null,
        pairingRequested: false,
        qr: null,
        pairingCode: null,
        qrShown: 0,
        lastPolled: Date.now(),
        retries: 0,
        stopping: false,
        reconnectTimer: null,
        sent: new Map(),
        lastError: null,
      };
      this.live.set(id, live);
    }
    return live;
  }

  private persist(
    sessionId: string,
    userId: number | null,
    patch: { enabled?: number; status?: WaStatus; phone?: string | null; wa_name?: string | null; connected_at?: number | null },
  ) {
    const now = Date.now();
    this.db.run(
      `INSERT INTO wa_connections (session_id, user_id, enabled, status, updated_at)
       VALUES (?, ?, 0, 'disconnected', ?)
       ON CONFLICT (session_id) DO NOTHING`,
      sessionId,
      userId,
      now,
    );
    // Explicit column mapping — never a dynamic column name from input.
    if (patch.enabled !== undefined)
      this.db.run("UPDATE wa_connections SET enabled = ?, updated_at = ? WHERE session_id = ?", patch.enabled, now, sessionId);
    if (patch.status !== undefined)
      this.db.run("UPDATE wa_connections SET status = ?, updated_at = ? WHERE session_id = ?", patch.status, now, sessionId);
    if (patch.phone !== undefined)
      this.db.run("UPDATE wa_connections SET phone = ? WHERE session_id = ?", patch.phone, sessionId);
    if (patch.wa_name !== undefined)
      this.db.run("UPDATE wa_connections SET wa_name = ? WHERE session_id = ?", patch.wa_name, sessionId);
    if (patch.connected_at !== undefined)
      this.db.run("UPDATE wa_connections SET connected_at = ? WHERE session_id = ?", patch.connected_at, sessionId);
  }

  private setStatus(live: Live, status: WaStatus) {
    live.status = status;
    this.persist(live.id, live.userId, { status });
    this.onStatus?.(live.id, status);
  }

  private async start(live: Live): Promise<void> {
    if (live.sock) return;
    live.stopping = false;
    live.pairingRequested = false;
    if (live.reconnectTimer) {
      clearTimeout(live.reconnectTimer);
      live.reconnectTimer = null;
    }
    this.setStatus(live, "connecting");

    const { state, saveCreds } = useDbAuthState(this.db, this.sealer, live.id);
    const version = await waVersion();
    if (live.stopping) return;
    const sock = makeWASocket({
      ...(version ? { version } : {}),
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, this.baileysLog),
      },
      logger: this.baileysLog,
      // Desktop emulation (["Mac OS"|"Windows", "Desktop"]) would unlock the
      // largest history, but WhatsApp currently rejects it (428 before the
      // QR, verified 2026-11-06). We keep our own name and still ask the
      // phone for a full sync (requireFullSync) and accept every history
      // chunk it sends; older messages are fetched on demand per chat.
      browser: Browsers.macOS("Alma AI"),
      // Keep the owner's phone receiving notifications as usual.
      markOnlineOnConnect: false,
      syncFullHistory: true,
      shouldSyncHistoryMessage: () => true,
      generateHighQualityLinkPreview: false,
      shouldIgnoreJid: (jid) =>
        Boolean(isJidGroup(jid) || isJidBroadcast(jid) || isJidNewsletter(jid)),
      getMessage: async (key) => (key.id ? live.sent.get(key.id) : undefined),
    });
    live.sock = sock;

    sock.ev.on("creds.update", () => void saveCreds());
    sock.ev.on("connection.update", (update) => {
      void this.onConnection(live, sock, update, state.creds.registered || Boolean(state.creds.me?.id));
    });
    const forward = <T>(name: string, handler: ((s: SessionRef, e: T) => void | Promise<void>) | null, event: T) => {
      if (live.userId === null || !handler || live.sock !== sock) return;
      Promise.resolve(handler({ id: live.id, userId: live.userId, sock }, event)).catch((err) =>
        this.log.error({ err, session: live.id }, `${name} handler failed`),
      );
    };
    sock.ev.on("messages.update", (event) => forward("update", this.onUpdate, event));
    sock.ev.on("call", (event) => forward("call", this.onCall, event));
    sock.ev.on("messaging-history.set", (event) => {
      if (live.userId === null || !this.onHistory || live.sock !== sock) return;
      Promise.resolve(this.onHistory({ id: live.id, userId: live.userId, sock }, event)).catch((err) =>
        this.log.error({ err, session: live.id }, "history handler failed"),
      );
    });
    sock.ev.on("messages.upsert", (event) => {
      if (live.userId === null || !this.onUpsert || live.sock !== sock) return;
      Promise.resolve(this.onUpsert({ id: live.id, userId: live.userId, sock }, event)).catch((err) =>
        this.log.error({ err, session: live.id }, "upsert handler failed"),
      );
    });
  }

  private async onConnection(
    live: Live,
    sock: WASocket,
    update: Partial<BaileysEventMap["connection.update"]>,
    wasRegistered: boolean,
  ) {
    if (live.sock !== sock) return; // stale socket
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      live.qrShown += 1;
      if (live.qrShown > MAX_QR_ROTATIONS) {
        live.lastError = "Время на подключение истекло";
        await this.stop(live, { wipe: true, disable: true });
        return;
      }
      if (live.method === "code" && live.pairingPhone) {
        if (!live.pairingRequested) {
          live.pairingRequested = true;
          try {
            const code = await sock.requestPairingCode(live.pairingPhone);
            live.pairingCode = code.length === 8 ? `${code.slice(0, 4)}-${code.slice(4)}` : code;
            live.qr = null;
            this.setStatus(live, "pairing");
          } catch (err) {
            this.log.warn({ err, session: live.id }, "pairing code request failed");
            live.lastError = "Не удалось получить код. Попробуйте QR-код.";
            await this.stop(live, { wipe: true, disable: true });
          }
        }
      } else {
        live.qr = await QRCode.toDataURL(qr, { margin: 1, width: 320, errorCorrectionLevel: "M" });
        live.pairingCode = null;
        this.setStatus(live, "qr");
      }
    }

    if (connection === "open") {
      live.retries = 0;
      live.qr = null;
      live.pairingCode = null;
      live.qrShown = 0;
      live.lastError = null;
      const phone = jidDecode(sock.user?.id)?.user ?? null;
      const prev = this.db.get<{ phone: string | null; connected_at: number | null }>(
        "SELECT phone, connected_at FROM wa_connections WHERE session_id = ?",
        live.id,
      );
      this.persist(live.id, live.userId, {
        enabled: 1,
        phone,
        wa_name: sock.user?.name ?? sock.user?.notify ?? null,
        connected_at: prev?.phone === phone && prev?.connected_at ? prev.connected_at : Date.now(),
      });
      this.setStatus(live, "connected");
      this.log.info({ session: live.id, phone: maskPhone(phone) }, "WhatsApp connected");
    }

    if (connection === "close") {
      live.sock = null;
      if (live.stopping) return;
      const code = (lastDisconnect?.error as { output?: { statusCode?: number } } | undefined)?.output
        ?.statusCode;
      this.log.info({ session: live.id, code }, "WhatsApp connection closed");

      if (code === DisconnectReason.loggedOut) {
        // Unlinked from the phone: the stored keys are useless now.
        live.lastError = "WhatsApp отключён с телефона";
        wipeAuthState(this.db, live.id);
        this.persist(live.id, live.userId, { enabled: 0, phone: null, wa_name: null, connected_at: null });
        this.setStatus(live, "disconnected");
        return;
      }
      if (code === DisconnectReason.connectionReplaced) {
        live.lastError = "Сессия открыта в другом месте";
        this.setStatus(live, "disconnected");
        return;
      }
      if (code === DisconnectReason.forbidden) {
        live.lastError = "WhatsApp запретил доступ этому номеру";
        wipeAuthState(this.db, live.id);
        this.persist(live.id, live.userId, { enabled: 0 });
        this.setStatus(live, "disconnected");
        return;
      }
      const registered = wasRegistered || hasRegisteredCreds(this.db, this.sealer, live.id);
      if (code === DisconnectReason.restartRequired) {
        // Normal right after scanning the QR code.
        void this.start(live);
        return;
      }
      if (!registered && Date.now() - live.lastPolled > LINK_IDLE_MS) {
        await this.stop(live, { wipe: true, disable: true });
        return;
      }
      live.retries += 1;
      const delay = Math.min(60_000, 1000 * 2 ** Math.min(live.retries, 6)) + Math.random() * 1000;
      this.setStatus(live, "connecting");
      live.reconnectTimer = setTimeout(() => {
        live.reconnectTimer = null;
        void this.start(live);
      }, delay);
    }
  }

  private async stop(live: Live, opts: { wipe: boolean; disable: boolean }) {
    live.stopping = true;
    if (live.reconnectTimer) {
      clearTimeout(live.reconnectTimer);
      live.reconnectTimer = null;
    }
    const sock = live.sock;
    live.sock = null;
    try {
      sock?.end(undefined);
    } catch {
      /* already closed */
    }
    live.qr = null;
    live.pairingCode = null;
    live.qrShown = 0;
    if (opts.wipe) wipeAuthState(this.db, live.id);
    if (opts.disable) this.persist(live.id, live.userId, { enabled: 0 });
    this.setStatus(live, "disconnected");
  }

  /** Stop QR/pairing screens nobody is watching any more. */
  private sweep() {
    const now = Date.now();
    for (const live of this.live.values()) {
      if ((live.status === "qr" || live.status === "pairing") && now - live.lastPolled > LINK_IDLE_MS) {
        void this.stop(live, { wipe: true, disable: true });
      }
    }
  }

  /* ---------- public API ---------- */

  view(sessionId: string): WaStatusView {
    const live = this.live.get(sessionId);
    if (live) live.lastPolled = Date.now();
    const row = this.db.get<{ status: WaStatus; phone: string | null; wa_name: string | null; connected_at: number | null }>(
      "SELECT status, phone, wa_name, connected_at FROM wa_connections WHERE session_id = ?",
      sessionId,
    );
    const status: WaStatus = live?.status ?? "disconnected";
    return {
      status,
      qr: status === "qr" ? (live?.qr ?? null) : null,
      pairing_code: status === "pairing" ? (live?.pairingCode ?? null) : null,
      phone: row?.phone ?? null,
      name: row?.wa_name ?? null,
      connected_at: row?.connected_at ?? null,
      last_error: live?.lastError ?? null,
    };
  }

  isConnected(sessionId: string): boolean {
    return this.live.get(sessionId)?.status === "connected";
  }

  async link(sessionId: string, userId: number | null, method: LinkMethod, phone?: string) {
    const live = this.ensure(sessionId, userId);
    if (live.status === "connected") return;
    if (method === "code" && !phone) throw new HttpError(400, "phone_required", "Укажите номер телефона");
    const switching = live.sock && (live.method !== method || live.pairingPhone !== (phone ?? null));
    live.method = method;
    live.pairingPhone = method === "code" ? (phone ?? null) : null;
    live.lastPolled = Date.now();
    live.lastError = null;
    live.qrShown = 0;
    this.persist(sessionId, userId, { enabled: 1 });
    if (switching) {
      await this.stop(live, { wipe: !hasRegisteredCreds(this.db, this.sealer, sessionId), disable: false });
    }
    if (!live.sock) await this.start(live);
  }

  async cancel(sessionId: string) {
    const live = this.live.get(sessionId);
    if (!live || live.status === "connected") return;
    await this.stop(live, { wipe: !hasRegisteredCreds(this.db, this.sealer, sessionId), disable: true });
  }

  /** Unlinks the device on WhatsApp's side and forgets the keys. */
  async logout(sessionId: string) {
    const live = this.live.get(sessionId);
    if (live?.sock && live.status === "connected") {
      live.stopping = true;
      try {
        await live.sock.logout();
      } catch (err) {
        this.log.warn({ err, session: sessionId }, "logout request failed");
      }
    }
    if (live) await this.stop(live, { wipe: true, disable: true });
    else wipeAuthState(this.db, sessionId);
    this.db.run(
      "UPDATE wa_connections SET enabled = 0, status = 'disconnected', phone = NULL, wa_name = NULL, connected_at = NULL WHERE session_id = ?",
      sessionId,
    );
  }

  socket(sessionId: string): WASocket | null {
    const live = this.live.get(sessionId);
    return live?.status === "connected" ? live.sock : null;
  }

  /** Ask the phone for messages older than the given one (arrive later
   *  as an ON_DEMAND history sync). */
  async requestHistory(
    sessionId: string,
    key: { remoteJid: string; fromMe: boolean; id: string },
    timestampSec: number,
    count = 50,
  ): Promise<void> {
    const sock = this.socket(sessionId);
    if (!sock) throw new HttpError(409, "wa_offline", "WhatsApp не подключён");
    await sock.fetchMessageHistory(count, key, timestampSec);
  }

  newMessageId(sessionId: string): string {
    const sock = this.live.get(sessionId)?.sock;
    return generateMessageIDV2(sock?.user?.id);
  }

  async sendText(sessionId: string, jid: string, text: string, messageId?: string): Promise<string> {
    const live = this.live.get(sessionId);
    const sock = live?.status === "connected" ? live.sock : null;
    if (!live || !sock) throw new HttpError(409, "wa_offline", "WhatsApp не подключён");
    const sent = await sock.sendMessage(jid, { text }, messageId ? { messageId } : undefined);
    const id = sent?.key.id ?? messageId ?? "";
    if (id && sent?.message) {
      live.sent.set(id, sent.message);
      if (live.sent.size > SENT_CACHE) {
        const oldest = live.sent.keys().next().value;
        if (oldest) live.sent.delete(oldest);
      }
    }
    return id;
  }

  async typing(sessionId: string, jid: string, on: boolean) {
    const sock = this.socket(sessionId);
    if (!sock) return;
    try {
      await sock.sendPresenceUpdate(on ? "composing" : "paused", jid);
    } catch {
      /* cosmetic only */
    }
  }
}
