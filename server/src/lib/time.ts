/** Kazakhstan has used a single time zone (UTC+5) since March 2024. */
export const TZ = "Asia/Almaty";

const partsFmt = new Intl.DateTimeFormat("en-GB", {
  timeZone: TZ,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
  weekday: "short",
});

export function localParts(ms: number) {
  const parts = Object.fromEntries(partsFmt.formatToParts(ms).map((p) => [p.type, p.value]));
  return {
    day: `${parts.year}-${parts.month}-${parts.day}`,
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    weekday: String(parts.weekday),
  };
}

/** Start of the local day (Almaty) containing `ms`, as epoch ms. */
export function startOfLocalDay(ms: number): number {
  const { hour, minute } = localParts(ms);
  const d = new Date(ms);
  return ms - (hour * 3600 + minute * 60 + d.getUTCSeconds()) * 1000 - d.getUTCMilliseconds();
}

export function humanNow(ms = Date.now()): string {
  return new Intl.DateTimeFormat("ru-RU", {
    timeZone: TZ,
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(ms);
}

/** "HH:MM" inside [start, end); supports windows over midnight. */
export function withinWindow(ms: number, start: string, end: string): boolean {
  const { hour, minute } = localParts(ms);
  const now = hour * 60 + minute;
  const toMin = (s: string) => {
    const [h, m] = s.split(":").map(Number);
    return (h ?? 0) * 60 + (m ?? 0);
  };
  const a = toMin(start);
  const b = toMin(end);
  if (a === b) return true;
  return a < b ? now >= a && now < b : now >= a || now < b;
}
