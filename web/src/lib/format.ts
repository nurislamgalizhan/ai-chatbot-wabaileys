export function formatPhone(digits: string | null | undefined): string {
  if (!digits) return "";
  if (digits.length === 11 && digits.startsWith("7")) {
    return `+7 ${digits.slice(1, 4)} ${digits.slice(4, 7)} ${digits.slice(7, 9)} ${digits.slice(9)}`;
  }
  return `+${digits}`;
}

/** Live mask for the phone input: "+7 707 123 45 67". */
export function maskPhoneInput(raw: string): string {
  let d = raw.replace(/\D/g, "");
  // The field is pre-filled with "+7 ": typing or pasting a full number
  // ("8 700…", "7 700…") on top of it must not double the country code.
  if (d.length > 11 && (d.startsWith("77") || d.startsWith("78"))) d = d.slice(1);
  if (d.startsWith("8")) d = `7${d.slice(1)}`;
  if (!d) return "";
  if (!d.startsWith("7")) return `+${d.slice(0, 15)}`;
  d = d.slice(0, 11);
  const p = [d.slice(0, 1), d.slice(1, 4), d.slice(4, 7), d.slice(7, 9), d.slice(9, 11)].filter(Boolean);
  return `+${p.join(" ")}`;
}

export const phoneDigits = (masked: string) => masked.replace(/\D/g, "");

export const isPhoneComplete = (masked: string) => {
  const d = phoneDigits(masked);
  return d.startsWith("7") ? d.length === 11 : d.length >= 10;
};

const TZ = "Asia/Almaty";

export function timeShort(ms: number): string {
  const d = new Date(ms);
  const now = new Date();
  const sameDay = d.toLocaleDateString("ru-RU", { timeZone: TZ }) === now.toLocaleDateString("ru-RU", { timeZone: TZ });
  if (sameDay) return d.toLocaleTimeString("ru-RU", { timeZone: TZ, hour: "2-digit", minute: "2-digit" });
  const yesterday = new Date(now.getTime() - 86400000);
  if (d.toLocaleDateString("ru-RU", { timeZone: TZ }) === yesterday.toLocaleDateString("ru-RU", { timeZone: TZ })) {
    return "вчера";
  }
  return d.toLocaleDateString("ru-RU", { timeZone: TZ, day: "2-digit", month: "2-digit" });
}

export const timeOnly = (ms: number) =>
  new Date(ms).toLocaleTimeString("ru-RU", { timeZone: TZ, hour: "2-digit", minute: "2-digit" });

export const dateLong = (ms: number) =>
  new Date(ms).toLocaleDateString("ru-RU", { timeZone: TZ, day: "numeric", month: "long", year: "numeric" });

export function dayLabel(ms: number): string {
  const d = new Date(ms);
  const now = new Date();
  const key = (x: Date) => x.toLocaleDateString("ru-RU", { timeZone: TZ });
  if (key(d) === key(now)) return "Сегодня";
  if (key(d) === key(new Date(now.getTime() - 86400000))) return "Вчера";
  return d.toLocaleDateString("ru-RU", { timeZone: TZ, day: "numeric", month: "long" });
}

export const shortDay = (iso: string) => {
  const [, m, d] = iso.split("-");
  return `${Number(d)}.${m}`;
};

export function initials(name: string | null | undefined, fallback = "?"): string {
  const parts = (name ?? "").trim().split(/\s+/).filter(Boolean).slice(0, 2);
  const out = parts.map((p) => p[0]?.toUpperCase() ?? "").join("");
  return out || fallback;
}

export function avatarHue(seed: string): number {
  let h = 5381;
  for (let i = 0; i < seed.length; i++) h = (h * 33) ^ seed.charCodeAt(i);
  return Math.abs(h) % 360;
}

export function plural(n: number, one: string, few: string, many: string): string {
  const m10 = n % 10;
  const m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
}

export function duration(sec: number | null): string {
  if (sec === null) return "—";
  if (sec < 60) return `${sec} с`;
  if (sec < 3600) return `${Math.round(sec / 60)} мин`;
  return `${(sec / 3600).toFixed(1)} ч`;
}

export const nf = (n: number) => n.toLocaleString("ru-RU");
