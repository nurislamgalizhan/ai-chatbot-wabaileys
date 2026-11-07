import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { getSettings } from "../ai/prompt.ts";
import type { Ctx } from "../context.ts";
import { localParts, startOfLocalDay } from "../lib/time.ts";
import { requireUser } from "../security/sessions.ts";
import { userSessionId } from "../wa/manager.ts";
import { accessView } from "../services/access.ts";
import { parse, userId } from "./util.ts";

const DAY = 24 * 3600_000;

interface Msg {
  chat_id: number;
  direction: "in" | "out";
  source: string;
  handoff: number;
  created_at: number;
}

export function summarize(rows: Msg[], from: number, days: number) {
  const byDay = new Map<string, { day: string; incoming: number; ai: number; operator: number }>();
  for (let i = 0; i < days; i++) {
    const d = localParts(from + i * DAY + 12 * 3600_000).day;
    byDay.set(d, { day: d, incoming: 0, ai: 0, operator: 0 });
  }
  const hours = Array.from({ length: 24 }, () => 0);
  let incoming = 0;
  let ai = 0;
  let operator = 0;
  let handoffs = 0;
  // First-response time: from the first unanswered customer message to the
  // next reply of anyone (bot or manager).
  const waiting = new Map<number, number>();
  const aiDelays: number[] = [];
  const humanDelays: number[] = [];
  for (const m of rows) {
    const p = localParts(m.created_at);
    const bucket = byDay.get(p.day);
    if (m.direction === "in") {
      incoming++;
      hours[p.hour]!++;
      if (bucket) bucket.incoming++;
      if (!waiting.has(m.chat_id)) waiting.set(m.chat_id, m.created_at);
      continue;
    }
    const started = waiting.get(m.chat_id);
    if (m.source === "ai") {
      ai++;
      if (bucket) bucket.ai++;
      if (m.handoff) handoffs++;
      if (started !== undefined) aiDelays.push(m.created_at - started);
    } else if (m.source === "operator_panel" || m.source === "operator_phone") {
      operator++;
      if (bucket) bucket.operator++;
      if (started !== undefined) humanDelays.push(m.created_at - started);
    }
    waiting.delete(m.chat_id);
  }
  const median = (a: number[]) => {
    if (a.length === 0) return null;
    const s = [...a].sort((x, y) => x - y);
    return Math.round(s[Math.floor(s.length / 2)]! / 1000);
  };
  return {
    by_day: [...byDay.values()],
    hours,
    totals: { incoming, ai, operator, handoffs },
    ai_share: ai + operator > 0 ? Math.round((ai / (ai + operator)) * 100) : null,
    median_first_reply_sec: { ai: median(aiDelays), human: median(humanDelays) },
  };
}

export function analyticsRoutes(app: FastifyInstance, ctx: Ctx) {
  const { db, wa } = ctx;
  const auth = { preHandler: requireUser(db) };

  app.get("/api/dashboard", auth, async (req) => {
    const uid = userId(req);
    const now = Date.now();
    const today = startOfLocalDay(now);
    const weekFrom = today - 6 * DAY;
    const rows = db.all<Msg>(
      `SELECT chat_id, direction, source, handoff, created_at FROM messages
        WHERE user_id = ? AND created_at >= ? AND status <> 'failed' ORDER BY created_at`,
      uid,
      weekFrom,
    );
    const week = summarize(rows, weekFrom, 7);
    const todayStats = summarize(
      rows.filter((r) => r.created_at >= today),
      today,
      1,
    );
    const chats = db.get<{ attention: number; unread: number; total: number; new_today: number }>(
      `SELECT SUM(needs_attention) AS attention,
              SUM(CASE WHEN unread_count > 0 THEN 1 ELSE 0 END) AS unread,
              COUNT(*) AS total,
              SUM(CASE WHEN created_at >= ? THEN 1 ELSE 0 END) AS new_today
         FROM chats WHERE user_id = ?`,
      today,
      uid,
    );
    const recent = db.all<Record<string, string | number | null>>(
      `SELECT id, name, phone, needs_attention, unread_count, last_message_at, last_message_preview
         FROM chats WHERE user_id = ? ORDER BY last_message_at DESC LIMIT 6`,
      uid,
    );
    const kbCount = db.get<{ n: number }>("SELECT COUNT(*) AS n FROM kb_entries WHERE user_id = ? AND is_active = 1", uid)?.n ?? 0;
    const settings = getSettings(db, uid);
    const until = db.get<{ ai_access_until: number | null }>("SELECT ai_access_until FROM users WHERE id = ?", uid);
    return {
      ai_access: accessView(until?.ai_access_until ?? null),
      today: { ...todayStats.totals, new_chats: chats?.new_today ?? 0 },
      week: week.by_day,
      ai_share_week: week.ai_share,
      needs_attention: chats?.attention ?? 0,
      unread_chats: chats?.unread ?? 0,
      total_chats: chats?.total ?? 0,
      whatsapp: wa.view(userSessionId(uid)),
      ai_enabled: Boolean(settings.ai_enabled),
      ai_configured: ctx.ai.enabled,
      kb_count: kbCount,
      agent_configured: Boolean(settings.instructions.trim() || settings.business_about.trim()),
      recent: recent.map((r) => ({ ...r, needs_attention: Boolean(r.needs_attention) })),
    };
  });

  app.get("/api/analytics", auth, async (req) => {
    const q = parse(z.object({ days: z.coerce.number().int().refine((d) => [7, 30, 90].includes(d)).default(30) }), req.query);
    const uid = userId(req);
    const from = startOfLocalDay(Date.now()) - (q.days - 1) * DAY;
    const rows = db.all<Msg>(
      `SELECT chat_id, direction, source, handoff, created_at FROM messages
        WHERE user_id = ? AND created_at >= ? AND status <> 'failed' ORDER BY created_at`,
      uid,
      from,
    );
    const s = summarize(rows, from, q.days);
    const chats = db.get<{ new_chats: number; active: number }>(
      `SELECT SUM(CASE WHEN created_at >= ? THEN 1 ELSE 0 END) AS new_chats,
              SUM(CASE WHEN last_message_at >= ? THEN 1 ELSE 0 END) AS active
         FROM chats WHERE user_id = ?`,
      from,
      from,
      uid,
    );
    const top = db.all<Record<string, string | number | null>>(
      `SELECT c.id, c.name, c.phone, COUNT(m.id) AS messages
         FROM chats c JOIN messages m ON m.chat_id = c.id
        WHERE c.user_id = ? AND m.created_at >= ?
        GROUP BY c.id ORDER BY messages DESC LIMIT 5`,
      uid,
      from,
    );
    return {
      days: q.days,
      ...s,
      chats: { new: chats?.new_chats ?? 0, active: chats?.active ?? 0 },
      top_chats: top,
    };
  });
}
