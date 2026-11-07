import { createReadStream } from "node:fs";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { Ctx } from "../context.ts";
import type { Db } from "../db.ts";
import { HttpError, notFound } from "../lib/errors.ts";
import { userSessionId } from "../wa/manager.ts";
import { INLINE_TYPES } from "../wa/media.ts";

/* Queries shared by the managers' cabinet and the chief's read-only view.
 * Every query is scoped by user_id taken from the verified session. */

export const PAGE = 30;
export const MSG_PAGE = 50;

/** Effective mode in SQL: an expired pause reads as "auto". */
export const MODE_SQL = `CASE WHEN c.mode = 'paused' AND COALESCE(c.paused_until, 0) <= ? THEN 'auto' ELSE c.mode END`;

export type ChatFilter = "all" | "attention" | "unread" | "unresolved" | "human" | "deleted";

export interface ChatListRow {
  id: number;
  name: string | null;
  phone: string | null;
  mode: string;
  paused_until: number | null;
  needs_attention: number;
  is_resolved: number;
  unread_count: number;
  last_message_at: number;
  last_message_preview: string | null;
}

export interface MessageRow {
  id: number;
  direction: string;
  source: string;
  kind: string;
  body: string | null;
  transcript: string | null;
  status: string;
  handoff: number;
  created_at: number;
  media_state: string;
  media_mime: string | null;
  media_name: string | null;
  media_size: number | null;
  media_seconds: number | null;
  deleted_at: number | null;
  deleted_by: string | null;
  edited_at: number | null;
}

const escapeLike = (s: string) => s.replace(/[\\%_]/g, (m) => `\\${m}`);

export function listChats(db: Db, uid: number, q: { filter: ChatFilter; q: string; cursor?: string | undefined }) {
  const now = Date.now();
  const where: string[] = ["c.user_id = ?"];
  const params: (string | number)[] = [now, uid];
  if (q.filter === "attention") where.push("c.needs_attention = 1");
  if (q.filter === "unread") where.push("c.unread_count > 0");
  if (q.filter === "unresolved") where.push("c.is_resolved = 0");
  if (q.filter === "deleted") where.push("EXISTS (SELECT 1 FROM messages d WHERE d.chat_id = c.id AND d.deleted_at IS NOT NULL)");
  if (q.filter === "human") {
    where.push(`${MODE_SQL} <> 'auto'`);
    params.push(now);
  }
  if (q.q) {
    const like = `%${escapeLike(q.q)}%`;
    const digits = q.q.replace(/\D/g, "");
    where.push(
      `(c.name LIKE ? ESCAPE '\\' OR c.last_message_preview LIKE ? ESCAPE '\\'${digits.length >= 3 ? " OR c.phone LIKE ?" : ""})`,
    );
    params.push(like, like);
    if (digits.length >= 3) params.push(`%${digits}%`);
  }
  if (q.cursor) {
    const [at, id] = q.cursor.split("_").map(Number);
    where.push("(c.last_message_at < ? OR (c.last_message_at = ? AND c.id < ?))");
    params.push(at!, at!, id!);
  }
  params.push(PAGE + 1);
  const rows = db.all<ChatListRow>(
    `SELECT c.id, c.name, c.phone, ${MODE_SQL} AS mode, c.paused_until, c.needs_attention,
            c.is_resolved, c.unread_count, c.last_message_at, c.last_message_preview
       FROM chats c WHERE ${where.join(" AND ")}
      ORDER BY c.last_message_at DESC, c.id DESC LIMIT ?`,
    ...params,
  );
  const more = rows.length > PAGE;
  const items = rows.slice(0, PAGE).map((r) => ({
    ...r,
    needs_attention: Boolean(r.needs_attention),
    is_resolved: Boolean(r.is_resolved),
  }));
  const last = items.at(-1);
  return { items, next_cursor: more && last ? `${last.last_message_at}_${last.id}` : null };
}

export function chatDetail(db: Db, uid: number, id: number) {
  const row = db.get<Record<string, number | string | null>>(
    `SELECT c.id, c.name, c.phone, ${MODE_SQL} AS mode, c.paused_until, c.needs_attention,
            c.is_resolved, c.unread_count, c.last_message_at, c.created_at,
            (SELECT COUNT(*) FROM messages m WHERE m.chat_id = c.id) AS message_count,
            (SELECT COUNT(*) FROM messages m WHERE m.chat_id = c.id AND m.source = 'ai') AS ai_count
       FROM chats c WHERE c.id = ? AND c.user_id = ?`,
    Date.now(),
    id,
    uid,
  );
  if (!row) throw notFound("Чат не найден");
  return { ...row, needs_attention: Boolean(row.needs_attention), is_resolved: Boolean(row.is_resolved) };
}

export function pageMessages(db: Db, uid: number, chatId: number, before?: number) {
  if (!db.get("SELECT 1 FROM chats WHERE id = ? AND user_id = ?", chatId, uid)) throw notFound("Чат не найден");
  const rows = db.all<MessageRow>(
    `SELECT id, direction, source, kind, body, transcript, status, handoff, created_at,
            media_state, media_mime, media_name, media_size, media_seconds, deleted_at, deleted_by, edited_at
       FROM messages WHERE chat_id = ? AND user_id = ?
       ${before ? "AND (created_at, id) < (SELECT created_at, id FROM messages WHERE id = ? AND user_id = ?)" : ""}
      ORDER BY created_at DESC, id DESC LIMIT ?`,
    ...(before ? [chatId, uid, before, uid, MSG_PAGE + 1] : [chatId, uid, MSG_PAGE + 1]),
  );
  const more = rows.length > MSG_PAGE;
  const items = rows.slice(0, MSG_PAGE).reverse();
  return { items, next_before: more ? (items[0]?.id ?? null) : null };
}

const EXT: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
  "video/mp4": "mp4",
  "audio/ogg": "ogg",
  "audio/mpeg": "mp3",
  "audio/mp4": "m4a",
  "application/pdf": "pdf",
};

/** A safe download name: no paths, quotes or control characters. */
function safeName(name: string | null, fallback: string): string {
  const clean = (name ?? "").replace(/[\u0000-\u001f\u007f"\\/]/g, "").trim().slice(0, 150);
  return clean || fallback;
}

const loading = new Map<number, Promise<boolean>>();

/**
 * Streams the media of one message of one chat of `uid`. Inline only for
 * types verified by content; everything else is a forced download.
 * `allowDeleted` is true only for the chief's view.
 */
export async function serveMedia(
  ctx: Ctx,
  req: FastifyRequest,
  reply: FastifyReply,
  uid: number,
  chatId: number,
  mid: number,
  allowDeleted: boolean,
) {
  const { db, wa, media, inbound } = ctx;
  type Row = {
    id: number;
    kind: string;
    media_state: string;
    media_file: string | null;
    media_mime: string | null;
    media_name: string | null;
    deleted_at: number | null;
  };
  const load = () =>
    db.get<Row>(
      `SELECT id, kind, media_state, media_file, media_mime, media_name, deleted_at FROM messages
        WHERE id = ? AND chat_id = ? AND user_id = ?`,
      mid,
      chatId,
      uid,
    );
  let row = load();
  if (!row || (row.deleted_at !== null && !allowDeleted)) throw notFound("Файл не найден");
  if (row.media_state === "lazy" || row.media_state === "failed") {
    const sock = wa.socket(userSessionId(uid));
    if (sock) {
      let job = loading.get(row.id);
      if (!job) {
        job = inbound.materialize(sock, uid, row.id).finally(() => loading.delete(mid));
        loading.set(row.id, job);
      }
      await job;
      row = load()!;
    }
  }
  const path = row.media_file ? media.path(uid, row.media_file) : null;
  const size = row.media_file ? media.size(uid, row.media_file) : null;
  if (row.media_state !== "stored" || !path || size === null) {
    throw new HttpError(404, "media_unavailable", "Файл недоступен — откройте его на телефоне");
  }
  const mime = row.media_mime ?? "application/octet-stream";
  const inline = row.kind !== "document" && INLINE_TYPES.has(mime);
  const name = safeName(row.media_name, `${row.kind}-${row.id}.${EXT[mime] ?? "bin"}`);
  reply.header("Content-Type", inline ? mime : "application/octet-stream");
  reply.header("Content-Disposition", `${inline ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(name)}`);
  reply.header("Content-Security-Policy", "default-src 'none'; sandbox");
  reply.header("Cache-Control", "private, max-age=86400");
  reply.header("Accept-Ranges", "bytes");
  const range = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range ?? ""));
  if (range && (range[1] || range[2])) {
    let start = range[1] ? Number(range[1]) : size - Number(range[2]);
    let end = range[1] && range[2] ? Number(range[2]) : size - 1;
    start = Math.max(0, start);
    end = Math.min(end, size - 1);
    if (start > end) {
      reply.header("Content-Range", `bytes */${size}`);
      return reply.status(416).send();
    }
    reply.status(206);
    reply.header("Content-Range", `bytes ${start}-${end}/${size}`);
    reply.header("Content-Length", end - start + 1);
    return reply.send(createReadStream(path, { start, end }));
  }
  reply.header("Content-Length", size);
  return reply.send(createReadStream(path));
}

/** Ask the linked phone for messages older than the oldest we have. */
export async function requestOlderHistory(ctx: Ctx, uid: number, chatId: number) {
  const { db, wa } = ctx;
  const chat = db.get<{ jid: string; lid: string | null }>("SELECT jid, lid FROM chats WHERE id = ? AND user_id = ?", chatId, uid);
  if (!chat) throw notFound("Чат не найден");
  const oldest = db.get<{ wa_id: string; wa_jid: string | null; direction: string; created_at: number }>(
    `SELECT wa_id, wa_jid, direction, created_at FROM messages
      WHERE chat_id = ? AND user_id = ? AND wa_id IS NOT NULL
      ORDER BY created_at ASC, id ASC LIMIT 1`,
    chatId,
    uid,
  );
  if (!oldest) throw new HttpError(409, "no_anchor", "В этом чате пока нет сообщений для отсчёта истории");
  await wa.requestHistory(
    userSessionId(uid),
    { remoteJid: oldest.wa_jid ?? chat.lid ?? chat.jid, fromMe: oldest.direction === "out", id: oldest.wa_id },
    Math.floor(oldest.created_at / 1000),
  );
  return { ok: true };
}
