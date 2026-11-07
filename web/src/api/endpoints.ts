import { api } from "./client";

/* ---------- types ---------- */

export interface User {
  id: number;
  name: string;
  company: string;
  phone: string;
  created_at: number;
}

export interface AiAccess {
  until: number | null;
  active: boolean;
  days_left: number;
}

export interface Me {
  user: User;
  ai_access: AiAccess;
  support_whatsapp: string | null;
}

export interface OtpSent {
  ok: true;
  expires_in: number;
  resend_in: number;
}

export type WaStatus = "disconnected" | "connecting" | "qr" | "pairing" | "connected";

export interface WhatsAppState {
  status: WaStatus;
  qr: string | null;
  pairing_code: string | null;
  phone: string | null;
  name: string | null;
  connected_at: number | null;
  last_error: string | null;
}

export type ChatMode = "auto" | "paused" | "human" | "off";
export type ChatFilter = "all" | "attention" | "unread" | "unresolved" | "human";

export interface ChatItem {
  id: number;
  name: string | null;
  phone: string | null;
  mode: ChatMode;
  paused_until: number | null;
  needs_attention: boolean;
  is_resolved: boolean;
  unread_count: number;
  last_message_at: number;
  last_message_preview: string | null;
}

export interface ChatDetail extends ChatItem {
  created_at: number;
  message_count: number;
  ai_count: number;
}

export type MediaState = "none" | "pending" | "lazy" | "stored" | "too_large" | "failed" | "expired";

export interface Message {
  id: number;
  direction: "in" | "out";
  source: "customer" | "ai" | "operator_panel" | "operator_phone" | "system";
  kind: string;
  body: string | null;
  transcript: string | null;
  status: "ok" | "pending" | "sent" | "failed";
  handoff: boolean;
  created_at: number;
  media_state: MediaState;
  media_mime: string | null;
  media_name: string | null;
  media_size: number | null;
  media_seconds: number | null;
  deleted?: boolean;
  edited?: boolean;
}

export const mediaUrl = (chatId: number, messageId: number) => `/api/chats/${chatId}/messages/${messageId}/media`;

export interface AgentSettings {
  ai_enabled: boolean;
  bot_name: string;
  business_name: string;
  business_about: string;
  instructions: string;
  tone: "friendly" | "formal" | "concise";
  verbosity: "low" | "medium" | "high";
  quality: "balanced" | "quality";
  reply_delay_sec: number;
  operator_pause_min: number;
  handoff_enabled: boolean;
  handoff_message: string;
  schedule_mode: "always" | "work_hours" | "off_hours";
  work_start: string;
  work_end: string;
  voice_enabled: boolean;
  updated_at: number;
  ai_configured: boolean;
  models: { balanced: string; quality: string };
}

export type EditableSettings = Omit<AgentSettings, "ai_enabled" | "updated_at" | "ai_configured" | "models">;

export interface TestReply {
  reply: string;
  handoff: boolean;
  model: string;
  latency_ms: number;
  sources: string[];
}

export interface KbEntry {
  id: number;
  kind: "faq" | "doc";
  title: string;
  content: string;
  is_active: boolean;
  index_state: "pending" | "ready" | "error";
  created_at: number;
  updated_at: number;
}

export interface KbList {
  items: KbEntry[];
  stats: { active_chars: number; mode: "full" | "search"; full_context_limit: number };
}

export interface DayStat {
  day: string;
  incoming: number;
  ai: number;
  operator: number;
}

export interface Dashboard {
  ai_access: AiAccess;
  today: { incoming: number; ai: number; operator: number; handoffs: number; new_chats: number };
  week: DayStat[];
  ai_share_week: number | null;
  needs_attention: number;
  unread_chats: number;
  total_chats: number;
  whatsapp: WhatsAppState;
  ai_enabled: boolean;
  ai_configured: boolean;
  kb_count: number;
  agent_configured: boolean;
  recent: {
    id: number;
    name: string | null;
    phone: string | null;
    needs_attention: boolean;
    unread_count: number;
    last_message_at: number;
    last_message_preview: string | null;
  }[];
}

export interface Analytics {
  days: number;
  by_day: DayStat[];
  hours: number[];
  totals: { incoming: number; ai: number; operator: number; handoffs: number };
  ai_share: number | null;
  median_first_reply_sec: { ai: number | null; human: number | null };
  chats: { new: number; active: number };
  top_chats: { id: number; name: string | null; phone: string | null; messages: number }[];
}

export interface AdminUser {
  id: number;
  name: string;
  company: string;
  phone: string;
  created_at: number;
  wa_status: string;
  wa_phone: string | null;
  chats: number;
  messages_30d: number;
  ai_access: AiAccess;
  check: AiAccess & { has_key: boolean };
}

export interface AdminOverview {
  sender: WhatsAppState;
  admin_phone_set: boolean;
  today: string;
  users: AdminUser[];
}

export interface AuditItem {
  at: number;
  action: string;
  result: "ok" | "fail";
  ip: string | null;
  target: string | null;
  meta: Record<string, unknown> | null;
}

/* ---------- auth ---------- */

export const registerStart = (b: { name: string; company: string; phone: string; password: string }) =>
  api<OtpSent>("POST", "/api/auth/register/start", b);
export const registerVerify = (b: { phone: string; code: string }) => api<Me>("POST", "/api/auth/register/verify", b);
/** A regular account gets its session; the platform admin gets a second step. */
export type LoginResult = Me | { two_factor: true; whatsapp: boolean };
export const login = (b: { phone: string; password: string }) => api<LoginResult>("POST", "/api/auth/login", b);
export const twoFactorRecovery = () => api<{ ok: true; file: string }>("POST", "/api/auth/2fa/recovery");
export const twoFactorVerify = (method: "whatsapp" | "recovery", code: string) =>
  api<{ admin: true }>("POST", "/api/auth/2fa/verify", { method, code });
export const twoFactorCancel = () => api<{ ok: true }>("POST", "/api/auth/2fa/cancel");
export const logout = () => api<{ ok: true }>("POST", "/api/auth/logout");
export const resetStart = (b: { phone: string }) => api<OtpSent>("POST", "/api/auth/reset/start", b);
export const resetVerify = (b: { phone: string; code: string; password: string }) =>
  api<Me>("POST", "/api/auth/reset/verify", b);

export const getMe = () => api<Me>("GET", "/api/me");
export const updateMe = (b: { name: string; company: string }) => api<Me>("PATCH", "/api/me", b);
export const changePassword = (b: { current_password: string; new_password: string }) =>
  api<{ ok: true }>("POST", "/api/me/password", b);
export const deleteAccount = (b: { password: string }) => api<{ ok: true }>("POST", "/api/me/delete", b);

/* ---------- whatsapp ---------- */

export const getWhatsApp = () => api<WhatsAppState>("GET", "/api/whatsapp");
export const linkWhatsApp = (b: { method: "qr" } | { method: "code"; phone: string }) =>
  api<WhatsAppState>("POST", "/api/whatsapp/link", b);
export const cancelWhatsApp = () => api<WhatsAppState>("POST", "/api/whatsapp/cancel");
export const logoutWhatsApp = () => api<WhatsAppState>("POST", "/api/whatsapp/logout");

/* ---------- chats ---------- */

export const listChats = (filter: ChatFilter, q: string, cursor?: string) => {
  const p = new URLSearchParams({ filter });
  if (q) p.set("q", q);
  if (cursor) p.set("cursor", cursor);
  return api<{ items: ChatItem[]; next_cursor: string | null }>("GET", `/api/chats?${p}`);
};
export const getChat = (id: number) => api<ChatDetail>("GET", `/api/chats/${id}`);
export const listMessages = (id: number, before?: number) =>
  api<{ items: Message[]; next_before: number | null }>(
    "GET",
    `/api/chats/${id}/messages${before ? `?before=${before}` : ""}`,
  );
export const markRead = (id: number) => api<{ ok: true }>("POST", `/api/chats/${id}/read`);
export const sendMessage = (id: number, body: string) =>
  api<{ ok: true; id: number }>("POST", `/api/chats/${id}/messages`, { body });
export const setChatMode = (id: number, mode: ChatMode, minutes?: number) =>
  api<{ ok: true }>("POST", `/api/chats/${id}/mode`, minutes ? { mode, minutes } : { mode });
export const requestHistory = (id: number) => api<{ ok: true }>("POST", `/api/chats/${id}/history`);
export const resolveChat = (id: number, resolved: boolean) =>
  api<{ ok: true }>("POST", `/api/chats/${id}/resolve`, { resolved });

/* ---------- agent & knowledge ---------- */

export const getAgent = () => api<AgentSettings>("GET", "/api/agent");
export const saveAgent = (b: EditableSettings) => api<AgentSettings>("PUT", "/api/agent", b);
export const toggleAi = (enabled: boolean) => api<{ ai_enabled: boolean }>("POST", "/api/agent/toggle", { enabled });
export const testAgent = (b: { messages: { role: "user" | "assistant"; content: string }[]; settings?: EditableSettings }) =>
  api<TestReply>("POST", "/api/agent/test", b);

export const listKb = () => api<KbList>("GET", "/api/kb");
export const createKb = (b: { kind: "faq" | "doc"; title: string; content: string; is_active: boolean }) =>
  api<{ id: number }>("POST", "/api/kb", b);
export const updateKb = (id: number, b: { kind: "faq" | "doc"; title: string; content: string; is_active: boolean }) =>
  api<{ ok: true }>("PUT", `/api/kb/${id}`, b);
export const deleteKb = (id: number) => api<{ ok: true }>("DELETE", `/api/kb/${id}`);

/* ---------- analytics ---------- */

export const getDashboard = () => api<Dashboard>("GET", "/api/dashboard");
export const getAnalytics = (days: number) => api<Analytics>("GET", `/api/analytics?days=${days}`);

/* ---------- admin ---------- */

export const adminMe = () => api<{ admin: true; phone: string | null }>("GET", "/api/admin/me");
export const adminLogout = () => api<{ ok: true }>("POST", "/api/admin/logout");
export const adminLogoutAll = () => api<{ ok: true }>("POST", "/api/admin/logout-all");
export const adminOverview = () => api<AdminOverview>("GET", "/api/admin/overview");
export const adminAudit = () => api<{ items: AuditItem[] }>("GET", "/api/admin/audit");
export const adminSetAccess = (id: number, until: string | null) =>
  api<{ id: number; ai_access: AiAccess }>("POST", `/api/admin/users/${id}/access`, { until });
export const adminSetCheck = (id: number, until: string | null, rotate = false) =>
  api<{ id: number; check: AiAccess & { has_key: boolean }; key: string | null }>("POST", `/api/admin/users/${id}/check`, { until, rotate });
export const adminSender = () => api<WhatsAppState>("GET", "/api/admin/sender");
export const adminLinkSender = (b: { method: "qr" } | { method: "code"; phone: string }) =>
  api<WhatsAppState>("POST", "/api/admin/sender/link", b);
export const adminCancelSender = () => api<WhatsAppState>("POST", "/api/admin/sender/cancel");
export const adminLogoutSender = () => api<WhatsAppState>("POST", "/api/admin/sender/logout");
