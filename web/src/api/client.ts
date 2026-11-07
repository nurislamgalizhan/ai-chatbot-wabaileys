export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly data: Record<string, unknown>;

  constructor(status: number, code: string, message: string, data: Record<string, unknown> = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.data = data;
  }
}

export async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      credentials: "same-origin",
      // The server accepts JSON bodies only (CSRF hardening), so every
      // non-GET request carries one, even if empty.
      headers: method !== "GET" ? { "Content-Type": "application/json" } : undefined,
      body: method !== "GET" ? JSON.stringify(body ?? {}) : undefined,
    });
  } catch {
    throw new ApiError(0, "network", "Нет соединения с сервером");
  }
  const text = await res.text();
  let data: Record<string, unknown> = {};
  try {
    data = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    /* non-JSON error page */
  }
  if (!res.ok) {
    throw new ApiError(
      res.status,
      String(data.error ?? "error"),
      String(data.message ?? "Что-то пошло не так. Попробуйте ещё раз."),
      data,
    );
  }
  return data as T;
}

export const errorText = (err: unknown): string | null =>
  err ? (err instanceof ApiError ? err.message : "Что-то пошло не так") : null;
