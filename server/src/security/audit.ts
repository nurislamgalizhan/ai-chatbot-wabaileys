import type { Db } from "../db.ts";

export type AuditResult = "ok" | "fail";

/**
 * Append-only audit trail (UPDATE/DELETE are blocked by triggers).
 * Never put secrets, codes or message texts into `meta`.
 */
export function audit(
  db: Db,
  entry: {
    actor: string;
    action: string;
    target?: string | null;
    result: AuditResult;
    ip?: string | null;
    meta?: Record<string, string | number | boolean | null>;
  },
): void {
  db.run(
    "INSERT INTO audit_log (at, actor, action, target, result, ip, meta) VALUES (?, ?, ?, ?, ?, ?, ?)",
    Date.now(),
    entry.actor,
    entry.action,
    entry.target ?? null,
    entry.result,
    entry.ip ?? null,
    entry.meta ? JSON.stringify(entry.meta) : null,
  );
}

export function recentFailures(db: Db, action: string, target: string, windowMs: number): number {
  const row = db.get<{ n: number }>(
    "SELECT COUNT(*) AS n FROM audit_log WHERE action = ? AND target = ? AND result = 'fail' AND at > ?",
    action,
    target,
    Date.now() - windowMs,
  );
  return row?.n ?? 0;
}
