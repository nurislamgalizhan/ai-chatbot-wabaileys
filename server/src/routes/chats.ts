import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { getSettings } from "../ai/prompt.ts";
import type { Ctx } from "../context.ts";
import { HttpError, notFound } from "../lib/errors.ts";
import { audit } from "../security/audit.ts";
import { requireUser } from "../security/sessions.ts";
import { userSessionId } from "../wa/manager.ts";
import { chatDetail, listChats, type MessageRow, pageMessages, requestOlderHistory, serveMedia } from "./shared.ts";
import { idParam, parse, phoneField, RL_AUTH, userId } from "./util.ts";

/** Managers see "message deleted" — the kept original is for the chief only. */
function managerView(r: MessageRow) {
  const { deleted_at, deleted_by: _by, edited_at, ...rest } = r;
  const base = { ...rest, handoff: Boolean(r.handoff), deleted: deleted_at !== null, edited: edited_at !== null };
  return deleted_at !== null
    ? { ...base, body: null, transcript: null, media_state: "none", media_mime: null, media_name: null, media_size: null }
    : base;
}

export function chatRoutes(app: FastifyInstance, ctx: Ctx) {
  const { db, wa, responder } = ctx;
  const auth = { preHandler: requireUser(db) };

  /** Object-level authorization: the chat must belong to the caller. */
  const ownChat = (uid: number, chatId: number) => {
    const chat = db.get<{ id: number; jid: string; mode: string; paused_until: number | null }>(
      "SELECT id, jid, mode, paused_until FROM chats WHERE id = ? AND user_id = ?",
      chatId,
      uid,
    );
    if (!chat) throw notFound("Чат не найден");
    return chat;
  };

  /* ---------- WhatsApp connection of the current user ---------- */

  app.get("/api/whatsapp", auth, async (req) => wa.view(userSessionId(userId(req))));

  app.post("/api/whatsapp/link", { ...auth, ...RL_AUTH }, async (req) => {
    const body = parse(
      z.discriminatedUnion("method", [
        z.strictObject({ method: z.literal("qr") }),
        z.strictObject({ method: z.literal("code"), phone: phoneField }),
      ]),
      req.body,
    );
    const uid = userId(req);
    await wa.link(userSessionId(uid), uid, body.method, body.method === "code" ? body.phone : undefined);
    audit(db, { actor: `user:${uid}`, action: "wa_link_start", result: "ok", ip: req.ip, meta: { method: body.method } });
    return wa.view(userSessionId(uid));
  });

  app.post("/api/whatsapp/cancel", auth, async (req) => {
    const uid = userId(req);
    await wa.cancel(userSessionId(uid));
    return wa.view(userSessionId(uid));
  });

  app.post("/api/whatsapp/logout", auth, async (req) => {
    const uid = userId(req);
    await wa.logout(userSessionId(uid));
    audit(db, { actor: `user:${uid}`, action: "wa_logout", result: "ok", ip: req.ip });
    return wa.view(userSessionId(uid));
  });

  /* ---------- chats ---------- */

  app.get("/api/chats", auth, async (req) => {
    const q = parse(
      z.object({
        filter: z.enum(["all", "attention", "unread", "unresolved", "human"]).default("all"),
        q: z.string().trim().max(80).default(""),
        cursor: z
          .string()
          .regex(/^\d+_\d+$/)
          .optional(),
      }),
      req.query,
    );
    return listChats(db, userId(req), q);
  });

  app.get("/api/chats/:id", auth, async (req) => {
    const { id } = parse(idParam, req.params);
    return chatDetail(db, userId(req), id);
  });

  app.get("/api/chats/:id/messages", auth, async (req) => {
    const { id } = parse(idParam, req.params);
    const q = parse(z.object({ before: z.coerce.number().int().positive().optional() }), req.query);
    const page = pageMessages(db, userId(req), id, q.before);
    return { items: page.items.map(managerView), next_before: page.next_before };
  });

  /** Media of one message — only for the chat's owner, never of deleted ones. */
  app.get("/api/chats/:id/messages/:mid/media", auth, async (req, reply) => {
    const p = parse(
      z.strictObject({
        id: z.coerce.number().int().positive().max(2 ** 40),
        mid: z.coerce.number().int().positive().max(2 ** 40),
      }),
      req.params,
    );
    return serveMedia(ctx, req, reply, userId(req), p.id, p.mid, false);
  });

  app.post("/api/chats/:id/history", { ...auth, config: { rateLimit: { max: 6, timeWindow: "1 minute" } } }, async (req) => {
    const { id } = parse(idParam, req.params);
    return requestOlderHistory(ctx, userId(req), id);
  });

  app.post("/api/chats/:id/read", auth, async (req) => {
    const { id } = parse(idParam, req.params);
    const uid = userId(req);
    ownChat(uid, id);
    db.run("UPDATE chats SET unread_count = 0, needs_attention = 0 WHERE id = ? AND user_id = ?", id, uid);
    return { ok: true };
  });

  app.post("/api/chats/:id/messages", auth, async (req) => {
    const { id } = parse(idParam, req.params);
    const body = parse(z.strictObject({ body: z.string().trim().min(1, "Пустое сообщение").max(4000) }), req.body);
    const uid = userId(req);
    const chat = ownChat(uid, id);
    const session = userSessionId(uid);
    if (!wa.isConnected(session)) {
      throw new HttpError(409, "wa_offline", "WhatsApp не подключён — подключите номер в разделе «WhatsApp»");
    }
    const settings = getSettings(db, uid);
    const waId = wa.newMessageId(session);
    const now = Date.now();
    responder.cancel(id);
    const msgId = db.tx(() => {
      const mid = db.run(
        `INSERT INTO messages (chat_id, user_id, wa_id, direction, source, kind, body, status, created_at)
         VALUES (?, ?, ?, 'out', 'operator_panel', 'text', ?, 'pending', ?)`,
        id,
        uid,
        waId,
        body.body,
        now,
      ).lastInsertRowid;
      db.run(
        `UPDATE chats SET last_message_at = ?, last_message_preview = ?, needs_attention = 0,
                unread_count = 0 WHERE id = ?`,
        now,
        body.body.slice(0, 160),
        id,
      );
      // A human stepped in: the AI keeps quiet for a while in this chat.
      db.run(
        "UPDATE chats SET mode = 'paused', paused_until = ? WHERE id = ? AND mode IN ('auto', 'paused')",
        now + settings.operator_pause_min * 60_000,
        id,
      );
      return mid;
    });
    try {
      await wa.sendText(session, chat.jid, body.body, waId);
      db.run("UPDATE messages SET status = 'sent' WHERE id = ?", msgId);
    } catch (err) {
      req.log.error({ err, chatId: id }, "panel send failed");
      db.run("UPDATE messages SET status = 'failed', error = 'send_failed' WHERE id = ?", msgId);
      throw new HttpError(502, "send_failed", "Не удалось отправить сообщение в WhatsApp");
    }
    return { ok: true, id: msgId };
  });

  app.post("/api/chats/:id/mode", auth, async (req) => {
    const { id } = parse(idParam, req.params);
    const body = parse(
      z.strictObject({
        mode: z.enum(["auto", "paused", "human", "off"]),
        minutes: z.number().int().min(1).max(7 * 24 * 60).optional(),
      }),
      req.body,
    );
    const uid = userId(req);
    ownChat(uid, id);
    if (body.mode === "paused" && !body.minutes) throw new HttpError(400, "validation", "Укажите длительность паузы");
    const until = body.mode === "paused" ? Date.now() + body.minutes! * 60_000 : null;
    db.run("UPDATE chats SET mode = ?, paused_until = ? WHERE id = ? AND user_id = ?", body.mode, until, id, uid);
    if (body.mode === "auto") {
      // AI is back: answer a customer message left without a reply.
      const last = db.get<{ direction: string }>(
        "SELECT direction FROM messages WHERE chat_id = ? AND status <> 'failed' ORDER BY created_at DESC, id DESC LIMIT 1",
        id,
      );
      if (last?.direction === "in") responder.schedule(id, 1);
    } else {
      responder.cancel(id);
    }
    return { ok: true, mode: body.mode, paused_until: until };
  });

  app.post("/api/chats/:id/resolve", auth, async (req) => {
    const { id } = parse(idParam, req.params);
    const body = parse(z.strictObject({ resolved: z.boolean() }), req.body);
    const uid = userId(req);
    ownChat(uid, id);
    db.run(
      `UPDATE chats SET is_resolved = ?, needs_attention = CASE WHEN ? THEN 0 ELSE needs_attention END
        WHERE id = ? AND user_id = ?`,
      body.resolved ? 1 : 0,
      body.resolved ? 1 : 0,
      id,
      uid,
    );
    return { ok: true };
  });
}
