import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { FULL_CONTEXT_CHARS } from "../ai/kb.ts";
import { type AgentSettings, buildSystemPrompt, getSettings, historyToMessages } from "../ai/prompt.ts";
import type { Ctx } from "../context.ts";
import { HttpError, notFound } from "../lib/errors.ts";
import { requireUser } from "../security/sessions.ts";
import { hasAiAccess } from "../services/access.ts";
import { idParam, parse, userId } from "./util.ts";

const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Время в формате ЧЧ:ММ");

const SettingsSchema = z.strictObject({
  bot_name: z.string().trim().min(1, "Укажите имя ассистента").max(40),
  business_name: z.string().trim().max(120),
  business_about: z.string().max(4000),
  instructions: z.string().max(12000),
  tone: z.enum(["friendly", "formal", "concise"]),
  verbosity: z.enum(["low", "medium", "high"]),
  quality: z.enum(["balanced", "quality"]),
  reply_delay_sec: z.number().int().min(1).max(60),
  operator_pause_min: z.number().int().min(0).max(24 * 60),
  handoff_enabled: z.boolean(),
  handoff_message: z.string().trim().max(500),
  schedule_mode: z.enum(["always", "work_hours", "off_hours"]),
  work_start: hhmm,
  work_end: hhmm,
  voice_enabled: z.boolean(),
});

const MAX_KB_ENTRIES = 500;

function view(s: AgentSettings, ctx: Ctx) {
  return {
    ai_enabled: Boolean(s.ai_enabled),
    bot_name: s.bot_name,
    business_name: s.business_name,
    business_about: s.business_about,
    instructions: s.instructions,
    tone: s.tone,
    verbosity: s.verbosity,
    quality: s.quality,
    reply_delay_sec: s.reply_delay_sec,
    operator_pause_min: s.operator_pause_min,
    handoff_enabled: Boolean(s.handoff_enabled),
    handoff_message: s.handoff_message,
    schedule_mode: s.schedule_mode,
    work_start: s.work_start,
    work_end: s.work_end,
    voice_enabled: Boolean(s.voice_enabled),
    updated_at: s.updated_at,
    ai_configured: ctx.ai.enabled,
    models: { balanced: ctx.ai.modelFor("balanced"), quality: ctx.ai.modelFor("quality") },
  };
}

export function agentRoutes(app: FastifyInstance, ctx: Ctx) {
  const { db, ai, kb } = ctx;
  const auth = { preHandler: requireUser(db) };

  app.get("/api/agent", auth, async (req) => view(getSettings(db, userId(req)), ctx));

  app.put("/api/agent", auth, async (req) => {
    const b = parse(SettingsSchema, req.body);
    const uid = userId(req);
    getSettings(db, uid); // make sure the row exists
    db.run(
      `UPDATE agent_settings SET bot_name = ?, business_name = ?, business_about = ?, instructions = ?,
              tone = ?, verbosity = ?, quality = ?, reply_delay_sec = ?, operator_pause_min = ?,
              handoff_enabled = ?, handoff_message = ?, schedule_mode = ?, work_start = ?, work_end = ?,
              voice_enabled = ?, updated_at = ?
        WHERE user_id = ?`,
      b.bot_name,
      b.business_name,
      b.business_about,
      b.instructions,
      b.tone,
      b.verbosity,
      b.quality,
      b.reply_delay_sec,
      b.operator_pause_min,
      b.handoff_enabled ? 1 : 0,
      b.handoff_message,
      b.schedule_mode,
      b.work_start,
      b.work_end,
      b.voice_enabled ? 1 : 0,
      Date.now(),
      uid,
    );
    return view(getSettings(db, uid), ctx);
  });

  app.post("/api/agent/toggle", auth, async (req) => {
    const b = parse(z.strictObject({ enabled: z.boolean() }), req.body);
    const uid = userId(req);
    getSettings(db, uid);
    db.run("UPDATE agent_settings SET ai_enabled = ?, updated_at = ? WHERE user_id = ?", b.enabled ? 1 : 0, Date.now(), uid);
    return { ai_enabled: b.enabled };
  });

  /** Test chat: the real prompt and model, no WhatsApp, nothing stored. */
  app.post(
    "/api/agent/test",
    { ...auth, config: { rateLimit: { max: 20, timeWindow: "1 minute" } } },
    async (req) => {
      const b = parse(
        z.strictObject({
          messages: z
            .array(
              z.strictObject({
                role: z.enum(["user", "assistant"]),
                content: z.string().trim().min(1).max(2000),
              }),
            )
            .min(1)
            .max(20),
          settings: SettingsSchema.optional(),
        }),
        req.body,
      );
      if (!ai.enabled) {
        throw new HttpError(503, "ai_unconfigured", "OpenAI не настроен на сервере (OPENAI_API_KEY)");
      }
      const uid = userId(req);
      if (!hasAiAccess(db, uid)) {
        throw new HttpError(403, "no_ai_access", "Доступ к AI не активирован или истёк — обратитесь к администратору");
      }
      const saved = getSettings(db, uid);
      const s: AgentSettings = b.settings
        ? {
            ...saved,
            ...b.settings,
            handoff_enabled: b.settings.handoff_enabled ? 1 : 0,
            voice_enabled: b.settings.voice_enabled ? 1 : 0,
          }
        : saved;
      const lastUser = [...b.messages].reverse().find((m) => m.role === "user");
      const snippets = await kb.retrieve(uid, lastUser?.content ?? "");
      const history = b.messages.map((m) => ({
        direction: m.role === "user" ? ("in" as const) : ("out" as const),
        source: m.role === "user" ? "customer" : "ai",
        kind: "text",
        body: m.content,
        transcript: null,
      }));
      const started = Date.now();
      try {
        const answer = await ai.reply(
          ai.modelFor(s.quality),
          [{ role: "system", content: buildSystemPrompt(s, snippets) }, ...historyToMessages(history)],
          s.verbosity,
        );
        return {
          reply: answer.reply,
          handoff: answer.handoff && Boolean(s.handoff_enabled),
          model: answer.model,
          latency_ms: Date.now() - started,
          sources: [...new Map(snippets.map((x) => [x.entry_id, x.title])).values()].slice(0, 8),
        };
      } catch (err) {
        req.log.error({ err }, "sandbox model call failed");
        throw new HttpError(502, "ai_failed", "Модель не ответила. Попробуйте ещё раз.");
      }
    },
  );

  /* ---------- knowledge base ---------- */

  const EntrySchema = z.strictObject({
    kind: z.enum(["faq", "doc"]),
    title: z.string().trim().min(1, "Заполните заголовок").max(200),
    content: z.string().trim().min(1, "Заполните текст").max(30000, "Текст слишком длинный (до 30 000 символов)"),
    is_active: z.boolean().default(true),
  });

  const entryView = (r: Record<string, string | number | null>) => ({
    ...r,
    is_active: Boolean(r.is_active),
  });

  app.get("/api/kb", auth, async (req) => {
    const uid = userId(req);
    const items = db.all<Record<string, string | number | null>>(
      `SELECT id, kind, title, content, is_active, index_state, created_at, updated_at
         FROM kb_entries WHERE user_id = ? ORDER BY updated_at DESC, id DESC`,
      uid,
    );
    const activeChars = items
      .filter((i) => i.is_active)
      .reduce((n, i) => n + String(i.title).length + String(i.content).length, 0);
    return {
      items: items.map(entryView),
      stats: {
        active_chars: activeChars,
        mode: activeChars <= FULL_CONTEXT_CHARS ? "full" : "search",
        full_context_limit: FULL_CONTEXT_CHARS,
      },
    };
  });

  app.post("/api/kb", auth, async (req) => {
    const b = parse(EntrySchema, req.body);
    const uid = userId(req);
    const count = db.get<{ n: number }>("SELECT COUNT(*) AS n FROM kb_entries WHERE user_id = ?", uid)?.n ?? 0;
    if (count >= MAX_KB_ENTRIES) throw new HttpError(400, "kb_full", `Максимум ${MAX_KB_ENTRIES} записей`);
    const now = Date.now();
    const id = db.run(
      `INSERT INTO kb_entries (user_id, kind, title, content, is_active, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      uid,
      b.kind,
      b.title,
      b.content,
      b.is_active ? 1 : 0,
      now,
      now,
    ).lastInsertRowid;
    kb.invalidate(uid);
    void kb.index(uid, id).catch((err) => req.log.error({ err }, "kb index failed"));
    return { id };
  });

  app.put("/api/kb/:id", auth, async (req) => {
    const { id } = parse(idParam, req.params);
    const b = parse(EntrySchema, req.body);
    const uid = userId(req);
    const r = db.run(
      `UPDATE kb_entries SET kind = ?, title = ?, content = ?, is_active = ?, index_state = 'pending', updated_at = ?
        WHERE id = ? AND user_id = ?`,
      b.kind,
      b.title,
      b.content,
      b.is_active ? 1 : 0,
      Date.now(),
      id,
      uid,
    );
    if (r.changes === 0) throw notFound("Запись не найдена");
    kb.invalidate(uid);
    void kb.index(uid, id).catch((err) => req.log.error({ err }, "kb index failed"));
    return { ok: true };
  });

  app.delete("/api/kb/:id", auth, async (req) => {
    const { id } = parse(idParam, req.params);
    const uid = userId(req);
    const r = db.run("DELETE FROM kb_entries WHERE id = ? AND user_id = ?", id, uid);
    if (r.changes === 0) throw notFound("Запись не найдена");
    kb.invalidate(uid);
    return { ok: true };
  });
}
