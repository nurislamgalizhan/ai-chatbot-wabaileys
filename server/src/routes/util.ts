import type { FastifyRequest } from "fastify";
import { z } from "zod";
import { HttpError } from "../lib/errors.ts";
import { normalizePhone } from "../lib/phone.ts";

/** Strict validation: unknown keys are rejected, the first issue is shown. */
export function parse<T extends z.ZodType>(schema: T, data: unknown): z.infer<T> {
  const r = schema.safeParse(data ?? {});
  if (!r.success) {
    const issue = r.error.issues[0];
    const msg = issue?.message && !issue.message.startsWith("Invalid") ? issue.message : "Проверьте введённые данные";
    throw new HttpError(400, "validation", msg, { field: issue?.path.join(".") ?? null });
  }
  return r.data;
}

export const phoneField = z
  .string()
  .max(32)
  .transform((value, ctx) => {
    const p = normalizePhone(value);
    if (!p) {
      ctx.addIssue({ code: "custom", message: "Введите номер в формате +7 707 123 45 67" });
      return z.NEVER;
    }
    return p;
  });

export const passwordField = z
  .string()
  .min(8, "Пароль — минимум 8 символов")
  .max(128, "Пароль слишком длинный");

export const idParam = z.strictObject({ id: z.coerce.number().int().positive().max(2 ** 40) });

export const userId = (req: FastifyRequest): number => {
  if (!req.user) throw new HttpError(401, "unauthorized", "Требуется вход");
  return req.user.id;
};

export const RL_AUTH = { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } };
export const RL_STRICT = { config: { rateLimit: { max: 5, timeWindow: "1 minute" } } };
