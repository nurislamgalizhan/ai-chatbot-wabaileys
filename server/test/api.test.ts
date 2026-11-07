import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { normalizePhone } from "../src/lib/phone.ts";
import { hashPassword, verifyPassword } from "../src/security/crypto.ts";
import { lastCode, makeEnv, ORIGIN, registerUser, type TestEnv } from "./helpers.ts";

describe("phone numbers", () => {
  test("accepts Kazakhstan formats", () => {
    assert.equal(normalizePhone("+7 (707) 123-45-67"), "77071234567");
    assert.equal(normalizePhone("87071234567"), "77071234567");
    assert.equal(normalizePhone("7071234567"), "77071234567");
    assert.equal(normalizePhone("12"), null);
    assert.equal(normalizePhone("+7+7071234567"), null);
  });
});

describe("passwords", () => {
  test("argon2id round trip", async () => {
    const h = await hashPassword("correct horse");
    assert.match(h, /^\$argon2id\$/);
    assert.equal(await verifyPassword("correct horse", h), true);
    assert.equal(await verifyPassword("wrong", h), false);
  });
});

describe("auth API", () => {
  let env: TestEnv;
  before(async () => {
    env = await makeEnv();
  });
  after(async () => env.close());

  test("registration requires the WhatsApp code", async () => {
    const start = await env.app.inject({
      method: "POST",
      url: "/api/auth/register/start",
      headers: { origin: ORIGIN },
      payload: { name: "Айдана", company: "", phone: "8 701 111 22 33", password: "password-123" },
    });
    assert.equal(start.statusCode, 200);
    assert.equal(env.codes.at(-1)?.phone, "77011112233");

    const again = await env.app.inject({
      method: "POST",
      url: "/api/auth/register/start",
      headers: { origin: ORIGIN },
      payload: { name: "Айдана", company: "", phone: "87011112233", password: "password-123" },
    });
    assert.equal(again.statusCode, 429, "resend is throttled");

    const wrong = await env.app.inject({
      method: "POST",
      url: "/api/auth/register/verify",
      headers: { origin: ORIGIN },
      payload: { phone: "77011112233", code: "000000" === lastCode(env) ? "111111" : "000000" },
    });
    assert.equal(wrong.statusCode, 400);

    const ok = await env.app.inject({
      method: "POST",
      url: "/api/auth/register/verify",
      headers: { origin: ORIGIN },
      payload: { phone: "77011112233", code: lastCode(env) },
    });
    assert.equal(ok.statusCode, 200);
    assert.ok(String(ok.headers["set-cookie"]).includes("HttpOnly"));
    assert.equal(JSON.parse(ok.body).user.password_hash, undefined, "no hash in responses");

    const reuse = await env.app.inject({
      method: "POST",
      url: "/api/auth/register/verify",
      headers: { origin: ORIGIN },
      payload: { phone: "77011112233", code: lastCode(env) },
    });
    assert.equal(reuse.statusCode, 400, "a code works once");
  });

  test("login: generic error and lockout", async () => {
    await registerUser(env, "77012223344");
    const bad = (phone: string) =>
      env.app.inject({ method: "POST", url: "/api/auth/login", headers: { origin: ORIGIN }, payload: { phone, password: "nope-nope" } });
    const unknown = await bad("77019998877");
    const wrongPw = await bad("77012223344");
    assert.equal(unknown.statusCode, 401);
    assert.equal(JSON.parse(unknown.body).message, JSON.parse(wrongPw.body).message, "no account enumeration");
    for (let i = 0; i < 4; i++) await bad("77012223344");
    const good = await env.app.inject({
      method: "POST",
      url: "/api/auth/login",
      headers: { origin: ORIGIN },
      payload: { phone: "77012223344", password: "password-123" },
    });
    assert.equal(good.statusCode, 429, "locked after 5 failures even with the right password");
  });

  test("CSRF: mutating calls need our Origin", async () => {
    const noOrigin = await env.app.inject({ method: "POST", url: "/api/auth/login", payload: { phone: "77012223344", password: "x" } });
    assert.equal(noOrigin.statusCode, 403);
    const evil = await env.app.inject({
      method: "POST",
      url: "/api/auth/login",
      headers: { origin: "https://evil.example" },
      payload: { phone: "77012223344", password: "x" },
    });
    assert.equal(evil.statusCode, 403);
    const plain = await env.app.inject({
      method: "POST",
      url: "/api/auth/login",
      headers: { origin: ORIGIN, "content-type": "text/plain" },
      payload: "phone=1",
    });
    assert.equal(plain.statusCode, 415, "text/plain bodies are not parsed");
  });

  test("protected routes deny by default", async () => {
    for (const url of ["/api/me", "/api/chats", "/api/agent", "/api/kb", "/api/dashboard", "/api/whatsapp"]) {
      const r = await env.app.inject({ method: "GET", url });
      assert.equal(r.statusCode, 401, url);
    }
    const adminApi = await env.app.inject({ method: "GET", url: "/api/admin/overview" });
    assert.equal(adminApi.statusCode, 404, "the admin API looks like it does not exist");
  });

  test("users cannot see each other's chats (IDOR)", async () => {
    const a = await registerUser(env, "77013334455", "Анна");
    const b = await registerUser(env, "77014445566", "Борис");
    const aId = env.ctx.db.get<{ id: number }>("SELECT id FROM users WHERE phone = '77013334455'")!.id;
    const chatId = env.ctx.db.run(
      "INSERT INTO chats (user_id, jid, phone, last_message_at, created_at) VALUES (?, ?, ?, ?, ?)",
      aId,
      "77000000001@s.whatsapp.net",
      "77000000001",
      Date.now(),
      Date.now(),
    ).lastInsertRowid;
    const own = await env.app.inject({ method: "GET", url: `/api/chats/${chatId}`, headers: { cookie: a } });
    assert.equal(own.statusCode, 200);
    for (const [method, url] of [
      ["GET", `/api/chats/${chatId}`],
      ["GET", `/api/chats/${chatId}/messages`],
      ["POST", `/api/chats/${chatId}/read`],
      ["POST", `/api/chats/${chatId}/resolve`],
    ] as const) {
      const r = await env.app.inject({
        method,
        url,
        headers: { cookie: b, origin: ORIGIN },
        ...(method === "POST" ? { payload: url.endsWith("resolve") ? { resolved: true } : {} } : {}),
      });
      assert.equal(r.statusCode, 404, `${method} ${url}`);
    }
    const list = await env.app.inject({ method: "GET", url: "/api/chats", headers: { cookie: b } });
    assert.equal(JSON.parse(list.body).items.length, 0);
  });

  test("password reset does not reveal unknown numbers", async () => {
    const unknown = await env.app.inject({
      method: "POST",
      url: "/api/auth/reset/start",
      headers: { origin: ORIGIN },
      payload: { phone: "77055556677" },
    });
    assert.equal(unknown.statusCode, 200);
    assert.notEqual(env.codes.at(-1)?.phone, "77055556677", "nothing is sent to unknown numbers");
  });
});
