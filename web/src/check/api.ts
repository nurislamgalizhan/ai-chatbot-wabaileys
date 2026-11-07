import { api } from "../api/client";
import type { AiAccess, ChatItem, DayStat } from "../api/endpoints";
import type { ViewMessage } from "../components/Message";

export type CheckFilter = "all" | "attention" | "human" | "deleted";

export interface CheckMe {
  company: string;
  check_until: number;
  ai_access: AiAccess;
  whatsapp: { status: string; phone: string | null; name: string | null };
  chats: number;
  messages: number;
}

export interface CheckChat extends ChatItem {
  created_at: number;
  message_count: number;
  ai_count: number;
  deleted_count: number;
  edited_count: number;
  first_message_at: number | null;
}

export interface Profile {
  available: boolean;
  photo?: string | null;
  about?: string | null;
  business?: { description: string | null; category: string | null; website: string | null; email: string | null; address: string | null } | null;
}

export interface SearchHit {
  id: number;
  chat_id: number;
  direction: "in" | "out";
  source: string;
  kind: string;
  created_at: number;
  deleted: boolean;
  snippet: string;
  name: string | null;
  phone: string | null;
}

export interface CallItem {
  id: number;
  chat_id: number | null;
  phone: string | null;
  name: string | null;
  is_video: boolean;
  status: string;
  outcome: "answered" | "rejected" | "missed";
  started_at: number;
}

export interface Summary {
  days: number;
  by_day: DayStat[];
  hours: number[];
  totals: { incoming: number; ai: number; operator: number; handoffs: number };
  ai_share: number | null;
  median_first_reply_sec: { ai: number | null; human: number | null };
  operator_split: { panel: number; phone: number };
  deleted: { customer: number; business: number };
  calls: { total: number; missed: number };
  waiting_now: number;
}

export const checkLogin = (key: string) => api<{ ok: true }>("POST", "/api/check/login", { key });
export const checkLogout = () => api<{ ok: true }>("POST", "/api/check/logout");
export const checkMe = () => api<CheckMe>("GET", "/api/check/me");
export const checkChats = (filter: CheckFilter, q: string, cursor?: string) => {
  const p = new URLSearchParams({ filter });
  if (q) p.set("q", q);
  if (cursor) p.set("cursor", cursor);
  return api<{ items: ChatItem[]; next_cursor: string | null }>("GET", `/api/check/chats?${p}`);
};
export const checkChat = (id: number) => api<CheckChat>("GET", `/api/check/chats/${id}`);
export const checkMessages = (id: number, before?: number) =>
  api<{ items: ViewMessage[]; next_before: number | null }>("GET", `/api/check/chats/${id}/messages${before ? `?before=${before}` : ""}`);
export const checkProfile = (id: number) => api<Profile>("GET", `/api/check/chats/${id}/profile`);
export const checkHistory = (id: number) => api<{ ok: true }>("POST", `/api/check/chats/${id}/history`);
export const checkSearch = (q: string) => api<{ items: SearchHit[] }>("GET", `/api/check/search?q=${encodeURIComponent(q)}`);
export const checkCalls = () => api<{ items: CallItem[] }>("GET", "/api/check/calls");
export const checkSummary = (days: number) => api<Summary>("GET", `/api/check/summary?days=${days}`);
export const checkMediaUrl = (chatId: number, mid: number) => `/api/check/chats/${chatId}/messages/${mid}/media`;
