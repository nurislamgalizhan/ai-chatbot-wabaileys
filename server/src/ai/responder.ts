import type { FastifyBaseLogger } from "fastify";
import type { Db } from "../db.ts";
import { withinWindow } from "../lib/time.ts";
import { userSessionId, type WaManager } from "../wa/manager.ts";
import type { KnowledgeBase } from "./kb.ts";
import type { Ai } from "./openai.ts";
import { hasAiAccess } from "../services/access.ts";
import {
  buildSystemPrompt,
  getSettings,
  hasAnswerableText,
  historyToMessages,
  type HistoryItem,
  renderHistoryText,
} from "./prompt.ts";

const HISTORY_LIMIT = 16;
const STALE_MS = 6 * 3600_000; // never answer messages older than this
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface ChatRow {
  id: number;
  user_id: number;
  jid: string;
  mode: string;
  paused_until: number | null;
}

/**
 * Debounced auto-replies. A burst of customer messages ("Здравствуйте" /
 * "сколько стоит" / "на завтра") becomes ONE model call and one answer.
 */
export class Responder {
  private readonly timers = new Map<number, NodeJS.Timeout>();
  private readonly running = new Set<number>();
  private readonly again = new Set<number>();
  private readonly db: Db;
  private readonly wa: WaManager;
  private readonly ai: Ai;
  private readonly kb: KnowledgeBase;
  private readonly log: FastifyBaseLogger;
  private readonly waits = new Map<number, number>();
  /** Set by Inbound: a voice note in this chat is still being transcribed. */
  isBusy: (chatId: number) => boolean = () => false;

  constructor(deps: { db: Db; wa: WaManager; ai: Ai; kb: KnowledgeBase; log: FastifyBaseLogger }) {
    this.db = deps.db;
    this.wa = deps.wa;
    this.ai = deps.ai;
    this.kb = deps.kb;
    this.log = deps.log;
  }

  schedule(chatId: number, delaySec: number) {
    this.cancel(chatId);
    const t = setTimeout(() => {
      this.timers.delete(chatId);
      void this.run(chatId);
    }, Math.max(1, delaySec) * 1000);
    this.timers.set(chatId, t);
  }

  cancel(chatId: number) {
    const t = this.timers.get(chatId);
    if (t) clearTimeout(t);
    this.timers.delete(chatId);
  }

  shutdown() {
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
  }

  /** Effective mode, lifting an expired pause. */
  static effectiveMode(db: Db, chat: ChatRow): string {
    if (chat.mode === "paused" && (chat.paused_until ?? 0) <= Date.now()) {
      db.run("UPDATE chats SET mode = 'auto', paused_until = NULL WHERE id = ? AND mode = 'paused'", chat.id);
      return "auto";
    }
    return chat.mode;
  }

  private async run(chatId: number): Promise<void> {
    if (this.running.has(chatId)) {
      this.again.add(chatId);
      return;
    }
    this.running.add(chatId);
    try {
      await this.respond(chatId);
    } catch (err) {
      this.log.error({ err, chatId }, "auto-reply failed");
    } finally {
      this.running.delete(chatId);
      if (this.again.delete(chatId)) void this.run(chatId);
    }
  }

  private loadChat(chatId: number): ChatRow | undefined {
    return this.db.get<ChatRow>("SELECT id, user_id, jid, mode, paused_until FROM chats WHERE id = ?", chatId);
  }

  private async respond(chatId: number): Promise<void> {
    const chat = this.loadChat(chatId);
    if (!chat) return;
    if (!hasAiAccess(this.db, chat.user_id)) return; // admin did not grant / access expired
    const settings = getSettings(this.db, chat.user_id);
    if (!settings.ai_enabled) return;
    if (this.isBusy(chatId)) {
      // Wait for the transcript (at most ~60 s) instead of answering blind.
      const n = (this.waits.get(chatId) ?? 0) + 1;
      this.waits.set(chatId, n);
      if (n <= 30) this.schedule(chatId, 2);
      return;
    }
    this.waits.delete(chatId);
    if (Responder.effectiveMode(this.db, chat) !== "auto") return;
    const now = Date.now();
    if (settings.schedule_mode !== "always") {
      const inside = withinWindow(now, settings.work_start, settings.work_end);
      if (settings.schedule_mode === "work_hours" && !inside) return;
      if (settings.schedule_mode === "off_hours" && inside) return;
    }
    const session = userSessionId(chat.user_id);
    if (!this.wa.isConnected(session)) return;

    const history = this.db
      .all<HistoryItem & { id: number; created_at: number; status: string }>(
        `SELECT id, direction, source, kind, body, transcript, created_at, status
           FROM messages WHERE chat_id = ? AND deleted_at IS NULL ORDER BY created_at DESC, id DESC LIMIT ?`,
        chatId,
        HISTORY_LIMIT,
      )
      .reverse();
    const last = history.at(-1);
    // Someone (operator or the bot) already answered the latest message.
    if (!last || last.direction !== "in" || now - last.created_at > STALE_MS) return;

    const pendingItems: HistoryItem[] = [];
    for (let i = history.length - 1; i >= 0 && history[i]!.direction === "in"; i--) {
      pendingItems.unshift(history[i]!);
    }
    if (!pendingItems.some(hasAnswerableText)) {
      // Only photos/videos/documents (or an unreadable voice note): the AI
      // cannot see them, so a human should look instead of a blind reply.
      this.flagAttention(chatId);
      return;
    }
    const question = pendingItems.map(renderHistoryText).join("\n").trim();

    if (!this.ai.enabled) {
      this.flagAttention(chatId);
      this.log.warn({ chatId }, "OPENAI_API_KEY missing — cannot auto-reply");
      return;
    }

    await this.wa.typing(session, chat.jid, true);
    const model = this.ai.modelFor(settings.quality);
    let answer;
    try {
      const kb = await this.kb.retrieve(chat.user_id, question);
      const messages = [
        { role: "system" as const, content: buildSystemPrompt(settings, kb, now) },
        ...historyToMessages(history.filter((m) => m.status !== "failed")),
      ];
      answer = await this.ai.reply(model, messages, settings.verbosity);
    } catch (err) {
      await this.wa.typing(session, chat.jid, false);
      this.log.error({ err, chatId }, "model call failed");
      this.insertSystemNote(chat, "AI не смог ответить: сервис OpenAI недоступен. Ответьте клиенту вручную.");
      this.flagAttention(chatId);
      return;
    }
    if (!answer.reply) {
      await this.wa.typing(session, chat.jid, false);
      this.flagAttention(chatId);
      return;
    }

    // A short human-like typing pause, then re-check: an operator may have
    // taken over while the model was thinking.
    await sleep(Math.min(2500, 600 + answer.reply.length * 15));
    const fresh = this.loadChat(chatId);
    const newer = this.db.get<{ id: number }>(
      "SELECT id FROM messages WHERE chat_id = ? AND created_at >= ? AND id <> ? AND direction = 'out' LIMIT 1",
      chatId,
      last.created_at,
      last.id,
    );
    if (!fresh || Responder.effectiveMode(this.db, fresh) !== "auto" || newer || !getSettings(this.db, chat.user_id).ai_enabled) {
      await this.wa.typing(session, chat.jid, false);
      return;
    }

    // Persist BEFORE sending, with our own WhatsApp message id: the echo
    // of this message is then recognised as ours (UNIQUE user_id, wa_id),
    // and a retry never regenerates the text.
    const waId = this.wa.newMessageId(session);
    const created = Date.now();
    const msgId = this.db.tx(() => {
      const id = this.db.run(
        `INSERT INTO messages (chat_id, user_id, wa_id, direction, source, kind, body, status, handoff, model, tokens_in, tokens_out, created_at)
         VALUES (?, ?, ?, 'out', 'ai', 'text', ?, 'pending', ?, ?, ?, ?, ?)`,
        chatId,
        chat.user_id,
        waId,
        answer.reply,
        answer.handoff ? 1 : 0,
        answer.model,
        answer.tokensIn,
        answer.tokensOut,
        created,
      ).lastInsertRowid;
      this.db.run(
        "UPDATE chats SET last_message_at = ?, last_message_preview = ? WHERE id = ?",
        created,
        answer.reply.slice(0, 160),
        chatId,
      );
      return id;
    });

    try {
      await this.wa.sendText(session, chat.jid, answer.reply, waId);
      this.db.run("UPDATE messages SET status = 'sent' WHERE id = ?", msgId);
    } catch (err) {
      this.log.error({ err, chatId }, "WhatsApp send failed");
      this.db.run("UPDATE messages SET status = 'failed', error = 'send_failed' WHERE id = ?", msgId);
      this.flagAttention(chatId);
      return;
    } finally {
      await this.wa.typing(session, chat.jid, false);
    }

    if (answer.handoff && settings.handoff_enabled) {
      this.db.run(
        "UPDATE chats SET needs_attention = 1, mode = 'paused', paused_until = ? WHERE id = ? AND mode = 'auto'",
        Date.now() + settings.operator_pause_min * 60_000,
        chatId,
      );
      this.db.run("UPDATE chats SET needs_attention = 1 WHERE id = ?", chatId);
    }
  }

  private flagAttention(chatId: number) {
    this.db.run("UPDATE chats SET needs_attention = 1, is_resolved = 0 WHERE id = ?", chatId);
  }

  private insertSystemNote(chat: ChatRow, text: string) {
    this.db.run(
      `INSERT INTO messages (chat_id, user_id, direction, source, kind, body, status, created_at)
       VALUES (?, ?, 'out', 'system', 'text', ?, 'failed', ?)`,
      chat.id,
      chat.user_id,
      text,
      Date.now(),
    );
  }
}
