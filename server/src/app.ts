import { existsSync } from "node:fs";
import { join } from "node:path";
import cookie from "@fastify/cookie";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import fastifyStatic from "@fastify/static";
import Fastify, { type FastifyInstance } from "fastify";
import type { Ctx } from "./context.ts";
import { HttpError } from "./lib/errors.ts";
import { adminRoutes } from "./routes/admin.ts";
import { agentRoutes } from "./routes/agent.ts";
import { analyticsRoutes } from "./routes/analytics.ts";
import { authRoutes } from "./routes/auth.ts";
import { chatRoutes } from "./routes/chats.ts";
import { checkRoutes } from "./routes/check.ts";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export async function buildApp(ctx: Ctx): Promise<FastifyInstance> {
  const { cfg } = ctx;
  const app = Fastify({
    loggerInstance: ctx.log,
    trustProxy: cfg.TRUST_PROXY,
    bodyLimit: 512 * 1024,
    requestTimeout: 90_000,
    connectionTimeout: 90_000,
  });

  // Only JSON bodies: text/plain and form posts are classic CSRF vectors.
  app.removeContentTypeParser("text/plain");

  await app.register(cookie);
  await app.register(helmet, {
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        "default-src": ["'self'"],
        "script-src": ["'self'"],
        "style-src": ["'self'"],
        "img-src": ["'self'", "data:"],
        "font-src": ["'self'"],
        "connect-src": ["'self'"],
        "object-src": ["'none'"],
        "base-uri": ["'self'"],
        "form-action": ["'self'"],
        "frame-ancestors": ["'none'"],
        ...(cfg.isProd ? { "upgrade-insecure-requests": [] } : {}),
      },
    },
    hsts: cfg.isProd ? { maxAge: 31536000, includeSubDomains: true } : false,
    frameguard: { action: "deny" },
    crossOriginEmbedderPolicy: false,
    referrerPolicy: { policy: "strict-origin-when-cross-origin" },
  });
  await app.register(rateLimit, {
    max: 300,
    timeWindow: "1 minute",
    errorResponseBuilder: (_req, context) => ({
      statusCode: 429,
      error: "rate_limited",
      message: `Слишком много запросов. Повторите через ${Math.ceil(context.ttl / 1000)} с.`,
    }),
  });

  // CSRF: state-changing API calls must come from our own origin.
  app.addHook("onRequest", async (req) => {
    if (SAFE_METHODS.has(req.method) || !req.url.startsWith("/api/")) return;
    const origin = req.headers.origin;
    if (origin) {
      if (!cfg.allowedOrigins.has(origin)) throw new HttpError(403, "bad_origin", "Запрос отклонён");
      return;
    }
    if (req.headers["sec-fetch-site"] !== "same-origin") {
      throw new HttpError(403, "bad_origin", "Запрос отклонён");
    }
  });

  app.addHook("onSend", async (req, reply) => {
    if (req.url.startsWith("/api/") && !reply.hasHeader("Cache-Control")) reply.header("Cache-Control", "no-store");
  });

  app.get("/healthz", { logLevel: "warn" }, async () => ({ ok: true }));

  authRoutes(app, ctx);
  chatRoutes(app, ctx);
  agentRoutes(app, ctx);
  analyticsRoutes(app, ctx);
  adminRoutes(app, ctx);
  checkRoutes(app, ctx);

  const hasSpa = existsSync(join(cfg.WEB_DIST, "index.html"));
  const assetsDir = join(cfg.WEB_DIST, "assets");
  if (hasSpa) {
    // Files are looked up on disk per request (wildcard), so a rebuilt
    // bundle is served without a restart; a missing file falls through to
    // the not-found handler below.
    await app.register(fastifyStatic, {
      root: cfg.WEB_DIST,
      wildcard: true,
      index: false,
      setHeaders: (reply, path) => {
        reply.header(
          "Cache-Control",
          path.startsWith(assetsDir) ? "public, max-age=31536000, immutable" : "no-cache",
        );
      },
    });
    app.get("/", (_req, reply) => {
      reply.header("Cache-Control", "no-cache");
      return reply.sendFile("index.html");
    });
  }

  app.setNotFoundHandler((req, reply) => {
    const path = req.url.split("?")[0] ?? "";
    // Client-side routes of the SPA get index.html; API calls and missing
    // build files get a real 404 (never HTML with a 200).
    const isPage =
      hasSpa &&
      (req.method === "GET" || req.method === "HEAD") &&
      !path.startsWith("/api/") &&
      !path.startsWith("/assets/") &&
      !/\.[a-z0-9]{2,5}$/i.test(path);
    if (isPage) {
      reply.header("Cache-Control", "no-cache");
      return reply.sendFile("index.html");
    }
    return reply.status(404).send({ error: "not_found", message: "Не найдено" });
  });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof HttpError) {
      return reply.status(err.status).send({ error: err.code, message: err.message, ...(err.extra ?? {}) });
    }
    const e = err as { statusCode?: number; message?: string };
    const status = e.statusCode ?? 500;
    if (status === 429) {
      return reply.status(429).send({ error: "rate_limited", message: e.message || "Слишком много запросов" });
    }
    if (status < 500) {
      return reply.status(status).send({ error: "bad_request", message: "Некорректный запрос" });
    }
    req.log.error({ err }, "unhandled error");
    return reply.status(500).send({ error: "internal", message: "Внутренняя ошибка сервера" });
  });

  return app;
}
