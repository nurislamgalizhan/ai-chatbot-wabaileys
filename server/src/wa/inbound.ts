import {
  type BaileysEventMap,
  getContentType,
  isJidBroadcast,
  isJidGroup,
  isJidNewsletter,
  isJidStatusBroadcast,
  isLidUser,
  isPnUser,
  jidDecode,
  jidNormalizedUser,
  normalizeMessageContent,
  proto,
  type WAMessage,
  type WASocket,
} from "baileys";
import type { FastifyBaseLogger } from "fastify";
import type { Ai } from "../ai/openai.ts";
import { getSettings } from "../ai/prompt.ts";
import type { Responder } from "../ai/responder.ts";
import type { Db } from "../db.ts";
import { hasAiAccess } from "../services/access.ts";
import type { MediaStore } from "./media.ts";

const MAX_VOICE_SECONDS = 600;
const LIVE_WINDOW_MS = 5 * 60_000;
const MAX_TEXT = 8000;
/** Safety valve only: full history keeps everything a phone realistically has. */
const HISTORY_PER_CHAT = 100_000;

export type MessageKind =
  | "text" | "voice" | "audio" | "image" | "video" | "document" | "location" | "contact" | "other";

interface Parsed {
  kind: MessageKind;
  text: string;
  media?: { mime: string; size: number; seconds: number | null; name: string | null };
}

type Session = { id: string; userId: number; sock: WASocket };
type Who = { jid: string; lid: string | null; phone: string | null };

/** Turns a WhatsApp message into (kind, text, media meta); null = ignore. */
export function parseContent(msg: WAMessage): Parsed | null {
  const content = normalizeMessageContent(msg.message);
  if (!content) return null;
  const type = getContentType(content);
  const n = (v: unknown) => Number(v ?? 0) || 0;
  switch (type) {
    case "conversation":
      return { kind: "text", text: content.conversation ?? "" };
    case "extendedTextMessage":
      return { kind: "text", text: content.extendedTextMessage?.text ?? "" };
    case "imageMessage": {
      const m = content.imageMessage;
      return { kind: "image", text: m?.caption ?? "", media: { mime: m?.mimetype ?? "image/jpeg", size: n(m?.fileLength), seconds: null, name: null } };
    }
    case "videoMessage":
    case "ptvMessage": {
      const m = type === "videoMessage" ? content.videoMessage : content.ptvMessage;
      return { kind: "video", text: m?.caption ?? "", media: { mime: m?.mimetype ?? "video/mp4", size: n(m?.fileLength), seconds: n(m?.seconds) || null, name: null } };
    }
    case "audioMessage": {
      const m = content.audioMessage;
      return {
        kind: m?.ptt ? "voice" : "audio",
        text: "",
        media: { mime: m?.mimetype ?? "audio/ogg", size: n(m?.fileLength), seconds: n(m?.seconds) || null, name: null },
      };
    }
    case "documentMessage": {
      const m = content.documentMessage;
      return {
        kind: "document",
        text: m?.caption ?? "",
        media: { mime: m?.mimetype ?? "application/octet-stream", size: n(m?.fileLength), seconds: null, name: (m?.fileName ?? "документ").slice(0, 200) },
      };
    }
    case "locationMessage": {
      const l = content.locationMessage;
      const where = [l?.name, l?.address].filter(Boolean).join(", ");
      return { kind: "location", text: `${where ? `${where} ` : ""}(${l?.degreesLatitude}, ${l?.degreesLongitude})` };
    }
    case "contactMessage":
      return { kind: "contact", text: content.contactMessage?.displayName ?? "" };
    case "buttonsResponseMessage":
      return { kind: "text", text: content.buttonsResponseMessage?.selectedDisplayText ?? "" };
    case "listResponseMessage":
      return { kind: "text", text: content.listResponseMessage?.title ?? "" };
    case "templateButtonReplyMessage":
      return { kind: "text", text: content.templateButtonReplyMessage?.selectedDisplayText ?? "" };
    // Stickers, reactions, protocol/edit/poll updates: no chat entry, no reply.
    case "stickerMessage":
    case "reactionMessage":
    case "protocolMessage":
    case "senderKeyDistributionMessage":
    case "pollUpdateMessage":
    case "editedMessage":
    case "keepInChatMessage":
    case "pinInChatMessage":
    case undefined:
      return null;
    default:
      return { kind: "other", text: "" };
  }
}

export function preview(kind: string, text: string | null): string {
  const labels: Record<string, string> = {
    voice: "🎤 Голосовое сообщение",
    audio: "🎵 Аудио",
    image: "🖼 Фото",
    video: "🎬 Видео",
    document: "📄 Документ",
    location: "📍 Геолокация",
    contact: "👤 Контакт",
    other: "📎 Вложение",
  };
  const t = (text ?? "").trim();
  const base = kind === "text" ? t : [labels[kind] ?? "📎 Вложение", t].filter(Boolean).join(": ");
  return base.slice(0, 160);
}

function skipJid(jid: string | null | undefined): boolean {
  return !jid || Boolean(isJidGroup(jid) || isJidBroadcast(jid) || isJidNewsletter(jid) || isJidStatusBroadcast(jid));
}

export class Inbound {
  private readonly db: Db;
  private readonly ai: Ai;
  private readonly responder: Responder;
  private readonly media: MediaStore;
  private readonly log: FastifyBaseLogger;
  private readonly historyDays: number;
  /** Chats with a voice note still being transcribed: the bot waits. */
  private readonly inflight = new Map<number, number>();

  constructor(deps: { db: Db; ai: Ai; responder: Responder; media: MediaStore; log: FastifyBaseLogger; historyDays: number }) {
    this.db = deps.db;
    this.ai = deps.ai;
    this.responder = deps.responder;
    this.media = deps.media;
    this.log = deps.log;
    this.historyDays = deps.historyDays;
    this.responder.isBusy = (chatId) => (this.inflight.get(chatId) ?? 0) > 0;
  }

  /* ---------- identity ---------- */

  private async identify(sock: WASocket, msg: WAMessage, lidToPn?: Map<string, string>): Promise<Who | null> {
    const remote = msg.key.remoteJid;
    if (skipJid(remote)) return null;
    const alt = msg.key.remoteJidAlt;
    let pn = isPnUser(remote!) ? jidNormalizedUser(remote!) : alt && isPnUser(alt) ? jidNormalizedUser(alt) : null;
    const lid = isLidUser(remote!) ? jidNormalizedUser(remote!) : alt && isLidUser(alt) ? jidNormalizedUser(alt) : null;
    if (!pn && lid) {
      const fromHistory = lidToPn?.get(lid);
      if (fromHistory) pn = jidNormalizedUser(fromHistory);
      else {
        try {
          const mapped = await sock.signalRepository.lidMapping.getPNForLID(lid);
          if (mapped) pn = jidNormalizedUser(mapped);
        } catch {
          /* unknown mapping: keep LID */
        }
      }
    }
    const jid = pn ?? lid;
    if (!jid) return null;
    return { jid, lid, phone: pn ? (jidDecode(pn)?.user ?? null) : null };
  }

  private upsertChat(userId: number, who: Who, name: string | null, at: number): number {
    return this.db.tx(() => {
      let row = this.db.get<{ id: number; jid: string }>("SELECT id, jid FROM chats WHERE user_id = ? AND jid = ?", userId, who.jid);
      if (!row && who.lid) {
        row = this.db.get<{ id: number; jid: string }>(
          "SELECT id, jid FROM chats WHERE user_id = ? AND (lid = ? OR jid = ?)",
          userId,
          who.lid,
          who.lid,
        );
        if (row && row.jid !== who.jid) {
          this.db.run("UPDATE chats SET jid = ?, phone = COALESCE(?, phone) WHERE id = ?", who.jid, who.phone, row.id);
        }
      }
      if (row) {
        if (who.lid) this.db.run("UPDATE chats SET lid = ? WHERE id = ? AND lid IS NULL", who.lid, row.id);
        if (name) this.db.run("UPDATE chats SET name = ? WHERE id = ?", name.slice(0, 120), row.id);
        return row.id;
      }
      return this.db.run(
        `INSERT INTO chats (user_id, jid, lid, phone, name, last_message_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        userId,
        who.jid,
        who.lid,
        who.phone,
        name ? name.slice(0, 120) : null,
        at,
        at,
      ).lastInsertRowid;
    });
  }

  private insertMessage(m: {
    chatId: number;
    userId: number;
    waId: string;
    waJid: string | null;
    out: boolean;
    source: "customer" | "operator_phone";
    parsed: Parsed;
    at: number;
    ref: Uint8Array | null;
    mediaState: "none" | "pending" | "lazy" | "too_large";
  }): number {
    const p = m.parsed;
    const r = this.db.run(
      `INSERT INTO messages (chat_id, user_id, wa_id, wa_jid, direction, source, kind, body, status, created_at,
                             media_state, media_mime, media_name, media_size, media_seconds, media_ref)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (user_id, wa_id) DO NOTHING`,
      m.chatId,
      m.userId,
      m.waId,
      m.waJid,
      m.out ? "out" : "in",
      m.source,
      p.kind,
      p.text ? p.text.slice(0, MAX_TEXT) : null,
      m.out ? "sent" : "ok",
      m.at,
      m.mediaState,
      p.media?.mime.slice(0, 100) ?? null,
      p.media?.name ?? null,
      p.media?.size || null,
      p.media?.seconds ?? null,
      m.ref,
    );
    return r.changes === 0 ? 0 : r.lastInsertRowid;
  }

  private mediaStateFor(p: Parsed, live: boolean): "none" | "pending" | "lazy" | "too_large" {
    if (!p.media) return "none";
    if (p.media.size > this.media.maxBytes) return "too_large";
    return live ? "pending" : "lazy";
  }

  /* ---------- live traffic ---------- */

  handle = async (session: Session, event: BaileysEventMap["messages.upsert"]): Promise<void> => {
    for (const msg of event.messages) {
      try {
        await this.one(session, msg, event.type);
      } catch (err) {
        this.log.error({ err, session: session.id }, "failed to process message");
      }
    }
  };

  private async one(session: Session, msg: WAMessage, type: BaileysEventMap["messages.upsert"]["type"]) {
    const waId = msg.key.id;
    if (!waId) return;
    const at = Number(msg.messageTimestamp ?? 0) * 1000 || Date.now();
    const fromMe = Boolean(msg.key.fromMe);
    if (type !== "notify" && Date.now() - at > LIVE_WINDOW_MS) return; // history is imported separately

    const parsed = parseContent(msg);
    if (!parsed) return;
    const who = await this.identify(session.sock, msg);
    if (!who) return;
    const own = jidDecode(session.sock.user?.id)?.user;
    if (own && who.phone === own) return; // "Message yourself"
    const { userId } = session;

    if (fromMe && this.db.get("SELECT id FROM messages WHERE user_id = ? AND wa_id = ?", userId, waId)) {
      return; // echo of a message the bot or the panel sent
    }

    const chatId = this.upsertChat(userId, who, fromMe ? null : (msg.pushName ?? null), at);
    const state = this.mediaStateFor(parsed, true);
    const messageId = this.db.tx(() => {
      const id = this.insertMessage({
        chatId,
        userId,
        waId,
        waJid: msg.key.remoteJid ?? null,
        out: fromMe,
        source: fromMe ? "operator_phone" : "customer",
        parsed,
        at,
        ref: parsed.media ? this.media.sealRef(msg) : null,
        mediaState: state,
      });
      if (!id) return 0;
      if (fromMe) {
        // A manager answered from their phone: the bot steps aside.
        const settings = getSettings(this.db, userId);
        this.db.run(
          `UPDATE chats SET last_message_at = MAX(last_message_at, ?), last_message_preview = ?,
                  needs_attention = 0, unread_count = 0 WHERE id = ?`,
          at,
          preview(parsed.kind, parsed.text),
          chatId,
        );
        this.db.run(
          "UPDATE chats SET mode = 'paused', paused_until = ? WHERE id = ? AND mode IN ('auto', 'paused')",
          Date.now() + settings.operator_pause_min * 60_000,
          chatId,
        );
      } else {
        this.db.run(
          `UPDATE chats SET last_message_at = MAX(last_message_at, ?), last_message_preview = ?,
                  unread_count = unread_count + 1, is_resolved = 0 WHERE id = ?`,
          at,
          preview(parsed.kind, parsed.text),
          chatId,
        );
      }
      return id;
    });
    if (!messageId) return; // duplicate delivery

    if (fromMe) {
      this.responder.cancel(chatId);
      if (state === "pending") void this.storeMedia(session.sock, userId, messageId, msg);
      return;
    }

    const isVoice = parsed.kind === "voice" || parsed.kind === "audio";
    if (isVoice && state === "pending") {
      // The answer depends on what was said: transcribe BEFORE replying.
      this.inflight.set(chatId, (this.inflight.get(chatId) ?? 0) + 1);
      try {
        const buf = await this.storeMedia(session.sock, userId, messageId, msg);
        if (buf) await this.transcribe(userId, messageId, buf, parsed);
      } finally {
        const left = (this.inflight.get(chatId) ?? 1) - 1;
        if (left > 0) this.inflight.set(chatId, left);
        else this.inflight.delete(chatId);
      }
    } else if (state === "pending") {
      // Photos/videos/documents: shown in the chat, never sent to the AI.
      void this.storeMedia(session.sock, userId, messageId, msg);
    }

    if (type === "notify" || Date.now() - at < LIVE_WINDOW_MS) {
      this.responder.schedule(chatId, getSettings(this.db, userId).reply_delay_sec);
    }
  }

  /** Downloads and stores a media file; returns its bytes (or null). */
  private async storeMedia(sock: WASocket, userId: number, messageId: number, msg: WAMessage): Promise<Buffer | null> {
    try {
      const buf = await this.media.download(sock, msg);
      const saved = this.media.save(userId, buf);
      this.db.run(
        "UPDATE messages SET media_state = 'stored', media_file = ?, media_size = ?, media_mime = ? WHERE id = ?",
        saved.file,
        saved.size,
        saved.mime,
        messageId,
      );
      return buf;
    } catch (err) {
      const tooLarge = err instanceof Error && err.message === "media too large";
      this.db.run("UPDATE messages SET media_state = ? WHERE id = ?", tooLarge ? "too_large" : "failed", messageId);
      if (!tooLarge) this.log.warn({ err, messageId }, "media download failed");
      return null;
    }
  }

  private async transcribe(userId: number, messageId: number, buf: Buffer, parsed: Parsed) {
    if (!this.ai.enabled || !hasAiAccess(this.db, userId)) return;
    if ((parsed.media?.seconds ?? 0) > MAX_VOICE_SECONDS) return;
    try {
      const text = await this.ai.transcribe(buf, parsed.media?.mime ?? "audio/ogg");
      if (text) this.db.run("UPDATE messages SET transcript = ? WHERE id = ?", text.slice(0, 4000), messageId);
    } catch (err) {
      this.log.warn({ err, messageId }, "voice transcription failed");
    }
  }

  /** Lazy download for history media, triggered when someone opens it. */
  async materialize(sock: WASocket, userId: number, messageId: number): Promise<boolean> {
    const row = this.db.get<{ media_ref: Uint8Array | null; media_state: string }>(
      "SELECT media_ref, media_state FROM messages WHERE id = ? AND user_id = ?",
      messageId,
      userId,
    );
    if (!row?.media_ref || (row.media_state !== "lazy" && row.media_state !== "failed")) return false;
    const msg = this.media.openRef(row.media_ref);
    if (!msg) return false;
    return (await this.storeMedia(sock, userId, messageId, msg)) !== null;
  }

  /* ---------- deletions & edits (kept for the chief's view) ---------- */

  /**
   * "Delete for everyone" and edits arrive as messages.update. The original
   * text and media are KEPT and the message is only marked; the managers'
   * cabinet shows "message deleted", the chief's view shows what it was.
   */
  handleUpdate = async (session: Session, updates: BaileysEventMap["messages.update"]): Promise<void> => {
    for (const { key, update } of updates) {
      try {
        if (!key.id || skipJid(key.remoteJid)) continue;
        const row = this.db.get<{ id: number; body: string | null; deleted_at: number | null }>(
          "SELECT id, body, deleted_at FROM messages WHERE user_id = ? AND wa_id = ?",
          session.userId,
          key.id,
        );
        if (!row) continue;
        const revoked = update.message === null || update.messageStubType === proto.WebMessageInfo.StubType.REVOKE;
        if (revoked) {
          if (!row.deleted_at) {
            this.db.run(
              "UPDATE messages SET deleted_at = ?, deleted_by = ? WHERE id = ?",
              Date.now(),
              key.fromMe ? "business" : "customer",
              row.id,
            );
          }
          continue;
        }
        const edited = update.message?.editedMessage?.message;
        if (edited) {
          const parsed = parseContent({ key, message: edited } as WAMessage);
          const text = parsed?.text?.slice(0, MAX_TEXT) ?? null;
          if (text === null || text === row.body) continue;
          this.db.tx(() => {
            this.db.run("INSERT INTO message_edits (message_id, body, at) VALUES (?, ?, ?)", row.id, row.body, Date.now());
            this.db.run("UPDATE messages SET body = ?, edited_at = ? WHERE id = ?", text, Date.now(), row.id);
          });
        }
      } catch (err) {
        this.log.warn({ err }, "message update skipped");
      }
    }
  };

  /* ---------- calls (log only — never rejected, never answered) ---------- */

  handleCall = async (session: Session, calls: BaileysEventMap["call"]): Promise<void> => {
    for (const c of calls) {
      try {
        if (!c.id || c.isGroup) continue;
        const pnJid = c.callerPn && isPnUser(c.callerPn) ? jidNormalizedUser(c.callerPn) : isPnUser(c.from) ? jidNormalizedUser(c.from) : null;
        let phone = pnJid ? (jidDecode(pnJid)?.user ?? null) : null;
        if (!phone && isLidUser(c.from)) {
          const mapped = await session.sock.signalRepository.lidMapping.getPNForLID(jidNormalizedUser(c.from)).catch(() => null);
          if (mapped) phone = jidDecode(jidNormalizedUser(mapped))?.user ?? null;
        }
        const chat = phone
          ? this.db.get<{ id: number }>("SELECT id FROM chats WHERE user_id = ? AND phone = ?", session.userId, phone)
          : this.db.get<{ id: number }>("SELECT id FROM chats WHERE user_id = ? AND lid = ?", session.userId, jidNormalizedUser(c.from));
        const at = c.date ? new Date(c.date).getTime() : Date.now();
        this.db.run(
          `INSERT INTO calls (user_id, call_id, chat_id, phone, is_video, status, started_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (user_id, call_id) DO UPDATE SET
             status = CASE WHEN calls.status IN ('accept', 'reject') AND excluded.status = 'terminate' THEN calls.status ELSE excluded.status END,
             chat_id = COALESCE(calls.chat_id, excluded.chat_id),
             phone = COALESCE(calls.phone, excluded.phone),
             updated_at = excluded.updated_at`,
          session.userId,
          c.id,
          chat?.id ?? null,
          phone,
          c.isVideo ? 1 : 0,
          c.status,
          at,
          Date.now(),
        );
      } catch (err) {
        this.log.warn({ err }, "call event skipped");
      }
    }
  };

  /* ---------- history sync ---------- */

  /**
   * Chats that existed before the number was linked (and older messages the
   * owner asks for). Imported silently: no AI replies, no pauses, no unread
   * counters; media is fetched lazily when opened.
   */
  handleHistory = async (session: Session, event: BaileysEventMap["messaging-history.set"]): Promise<void> => {
    const { userId, sock } = session;
    const onDemand = event.syncType === proto.HistorySync.HistorySyncType.ON_DEMAND;
    const cutoff = onDemand || this.historyDays === 0 ? 0 : Date.now() - this.historyDays * 24 * 3600_000;
    const lidToPn = new Map<string, string>();
    for (const m of event.lidPnMappings ?? []) lidToPn.set(jidNormalizedUser(m.lid), m.pn);
    const names = new Map<string, string>();
    for (const c of event.contacts ?? []) {
      const n = c.name || c.notify || c.verifiedName;
      if (n && c.id) names.set(jidNormalizedUser(c.id), n);
    }
    for (const c of event.chats ?? []) if (c.name && c.id) names.set(jidNormalizedUser(c.id), c.name);

    const perChat = new Map<string, number>();
    const touched = new Set<number>();
    let imported = 0;
    const sorted = [...(event.messages ?? [])].sort(
      (a, b) => Number(b.messageTimestamp ?? 0) - Number(a.messageTimestamp ?? 0),
    );
    for (const msg of sorted) {
      try {
        const waId = msg.key.id;
        const at = Number(msg.messageTimestamp ?? 0) * 1000;
        if (!waId || !at || at < cutoff || skipJid(msg.key.remoteJid)) continue;
        const parsed = parseContent(msg);
        if (!parsed) continue;
        const who = await this.identify(sock, msg, lidToPn);
        if (!who) continue;
        const count = perChat.get(who.jid) ?? 0;
        if (count >= HISTORY_PER_CHAT) continue;
        perChat.set(who.jid, count + 1);
        const name =
          names.get(who.jid) ?? (who.lid ? names.get(who.lid) : undefined) ?? (msg.key.fromMe ? null : (msg.pushName ?? null));
        const chatId = this.upsertChat(userId, who, name ?? null, at);
        const id = this.insertMessage({
          chatId,
          userId,
          waId,
          waJid: msg.key.remoteJid ?? null,
          out: Boolean(msg.key.fromMe),
          source: msg.key.fromMe ? "operator_phone" : "customer",
          parsed,
          at,
          ref: parsed.media ? this.media.sealRef(msg) : null,
          mediaState: this.mediaStateFor(parsed, false),
        });
        if (id) {
          imported++;
          touched.add(chatId);
        }
      } catch (err) {
        this.log.warn({ err }, "history message skipped");
      }
    }
    for (const chatId of touched) {
      const last = this.db.get<{ created_at: number; kind: string; body: string | null }>(
        "SELECT created_at, kind, body FROM messages WHERE chat_id = ? ORDER BY created_at DESC, id DESC LIMIT 1",
        chatId,
      );
      const first = this.db.get<{ t: number }>("SELECT MIN(created_at) AS t FROM messages WHERE chat_id = ?", chatId);
      if (last) {
        this.db.run(
          "UPDATE chats SET last_message_at = ?, last_message_preview = ? WHERE id = ? AND last_message_at <= ?",
          last.created_at,
          preview(last.kind, last.body),
          chatId,
          last.created_at,
        );
        if (first?.t) this.db.run("UPDATE chats SET created_at = MIN(created_at, ?) WHERE id = ?", first.t, chatId);
      }
    }
    if (imported) this.log.info({ session: session.id, imported, chats: touched.size }, "history imported");
  };
}
