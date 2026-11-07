import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { decodeAdminHash, encodeAdminHash, RECOVERY_FILE } from "../src/security/admin.ts";
import { hashPassword } from "../src/security/crypto.ts";
import {
  ADMIN_PASSWORD,
  ADMIN_PHONE,
  adminLogin,
  cookieFrom,
  lastCode,
  makeEnv,
  ORIGIN,
  registerUser,
  type TestEnv,
} from "./helpers.ts";

describe("admin account protection", () => {
  let env: TestEnv;
  before(async () => {
    env = await makeEnv();
  });
  after(async () => env.close());

  const post = (url: string, payload: unknown, cookie?: string) =>
    env.app.inject({ method: "POST", url, headers: { origin: ORIGIN, ...(cookie ? { cookie } : {}) }, payload: payload as object });
  const get = (url: string, cookie?: string) => env.app.inject({ method: "GET", url, headers: cookie ? { cookie } : {} });

  test("outsiders cannot tell an admin area exists", async () => {
    const unknown = await get("/api/definitely-not-here");
    for (const url of ["/api/admin/overview", "/api/admin/me", "/api/admin/audit", "/api/admin/session"]) {
      const r = await get(url);
      assert.equal(r.statusCode, 404, url);
      assert.equal(r.body, unknown.body, `${url} answers exactly like a missing route`);
    }
    for (const url of ["/api/admin/login", "/api/admin/login/verify", "/api/auth/2fa/verify", "/api/auth/2fa/recovery"]) {
      const r = await post(url, { password: "x", method: "whatsapp", code: "123456" });
      assert.equal(r.statusCode, 404, url);
    }
  });

  test("the admin signs in through the ordinary /login, always with a second factor", async () => {
    env.wa.connected.add("system");
    const userWrong = await post("/api/auth/login", { phone: "77011112299", password: "wrong-password" });
    const adminWrong = await post("/api/auth/login", { phone: ADMIN_PHONE, password: "wrong-password" });
    assert.equal(adminWrong.statusCode, 401);
    assert.equal(adminWrong.body, userWrong.body, "a wrong admin password looks like any wrong password");

    const pw = await post("/api/auth/login", { phone: "+7 700 999 88 77", password: ADMIN_PASSWORD });
    assert.equal(pw.statusCode, 200);
    assert.deepEqual(JSON.parse(pw.body), { two_factor: true, whatsapp: true });
    assert.equal(env.codes.at(-1)?.phone, ADMIN_PHONE, "code goes to the admin's WhatsApp");
    assert.equal(cookieFrom(pw, "alma_sid"), "", "no user session for the admin");
    const pending = cookieFrom(pw, "alma_2fa");
    const setCookie = String([pw.headers["set-cookie"]].flat().at(-1));
    assert.match(setCookie, /Path=\/api\/auth\/2fa/);
    assert.match(setCookie, /SameSite=Strict/);
    assert.match(setCookie, /HttpOnly/);

    // The password-only session opens nothing in the admin API.
    for (const url of ["/api/admin/overview", "/api/admin/audit", "/api/admin/sender"]) {
      assert.equal((await get(url, pending)).statusCode, 404, url);
    }
    assert.equal((await post("/api/admin/sender/link", { method: "qr" }, pending)).statusCode, 404, "OTP sender is safe");

    const bad = await post("/api/auth/2fa/verify", { method: "whatsapp", code: lastCode(env) === "000000" ? "111111" : "000000" }, pending);
    assert.equal(bad.statusCode, 400);
    const ok = await post("/api/auth/2fa/verify", { method: "whatsapp", code: lastCode(env) }, pending);
    assert.equal(ok.statusCode, 200);
    assert.deepEqual(JSON.parse(ok.body), { admin: true });
    const full = cookieFrom(ok, "alma_admin");
    assert.match(String([ok.headers["set-cookie"]].flat().find((c) => String(c).startsWith("alma_admin="))), /Path=\/api\/admin/);
    assert.equal((await get("/api/admin/me", full)).statusCode, 200);
    assert.equal((await post("/api/auth/2fa/verify", { method: "whatsapp", code: lastCode(env) }, pending)).statusCode, 404, "pending session is gone");
    assert.ok(env.wa.sent.some((m) => m.text.includes("Выполнен вход в админ-панель")), "login alert sent to the admin");
  });

  test("recovery code from the server disk when WhatsApp is unavailable", async () => {
    env.wa.connected.delete("system");
    const pw = await post("/api/auth/login", { phone: ADMIN_PHONE, password: ADMIN_PASSWORD });
    assert.deepEqual(JSON.parse(pw.body), { two_factor: true, whatsapp: false });
    const pending = cookieFrom(pw, "alma_2fa");
    const rec = await post("/api/auth/2fa/recovery", {}, pending);
    assert.equal(rec.statusCode, 200);
    const file = join(env.dir, RECOVERY_FILE);
    const code = readFileSync(file, "utf8").split("\n")[0]!;
    const ok = await post("/api/auth/2fa/verify", { method: "recovery", code }, pending);
    assert.equal(ok.statusCode, 200);
    assert.equal(existsSync(file), false, "the code file is removed after use");
  });

  test("the admin number cannot be registered or reset by WhatsApp", async () => {
    const reg = await post("/api/auth/register/start", { name: "Хакер", company: "", phone: ADMIN_PHONE, password: "password-123" });
    assert.equal(reg.statusCode, 409);
    assert.equal(JSON.parse(reg.body).error, "phone_taken");
    const sentBefore = env.codes.length;
    const reset = await post("/api/auth/reset/start", { phone: ADMIN_PHONE });
    assert.equal(reset.statusCode, 200, "looks like any other number");
    assert.equal(env.codes.length, sentBefore, "but nothing is sent");
  });

  test("brute force on the admin number is locked out", async () => {
    const fresh = await makeEnv();
    try {
      const login = (password: string) =>
        fresh.app.inject({ method: "POST", url: "/api/auth/login", headers: { origin: ORIGIN }, payload: { phone: ADMIN_PHONE, password } });
      for (let i = 0; i < 5; i++) assert.equal((await login(`nope-${i}`)).statusCode, 401);
      const right = await login(ADMIN_PASSWORD);
      assert.equal(right.statusCode, 429, "locked even with the right password");
    } finally {
      await fresh.close();
    }
  });

  test("ADMIN_PASSWORD_HASH survives .env quoting", async () => {
    const enc = encodeAdminHash(await hashPassword("very-long-password"));
    assert.equal(enc.includes("$"), false);
    assert.ok(decodeAdminHash(enc));
    assert.equal(decodeAdminHash("garbage"), null);
  });

  test("admin grants and revokes AI access with an end date", async () => {
    // Fresh app: the HTTP limiter on code checks (5/min per IP) is part of the defence.
    const t = await makeEnv();
    const post = (url: string, payload: unknown, cookie?: string) =>
      t.app.inject({ method: "POST", url, headers: { origin: ORIGIN, ...(cookie ? { cookie } : {}) }, payload: payload as object });
    const get = (url: string, cookie?: string) => t.app.inject({ method: "GET", url, headers: cookie ? { cookie } : {} });
    try {
      const userCookie = await registerUser(t, "77021112233", "Клиент");
      const uid = t.ctx.db.get<{ id: number }>("SELECT id FROM users WHERE phone = '77021112233'")!.id;
      const me0 = JSON.parse((await get("/api/me", userCookie)).body);
      assert.equal(me0.ai_access.active, false, "no AI by default");
      assert.equal((await post(`/api/admin/users/${uid}/access`, { until: "2099-01-01" }, userCookie)).statusCode, 404, "a client cannot grant itself access");

      const admin = await adminLogin(t);
      assert.equal((await post(`/api/admin/users/${uid}/access`, { until: "2020-01-01" }, admin)).statusCode, 400);
      assert.equal((await post(`/api/admin/users/${uid}/access`, { until: "31.12.2026", extra: 1 }, admin)).statusCode, 400);
      assert.equal((await post(`/api/admin/users/999999/access`, { until: null }, admin)).statusCode, 404);

      const year = new Date().getFullYear() + 1;
      const grant = await post(`/api/admin/users/${uid}/access`, { until: `${year}-06-30` }, admin);
      assert.equal(grant.statusCode, 200);
      const body = JSON.parse(grant.body);
      assert.equal(body.ai_access.active, true);
      assert.equal(new Date(body.ai_access.until).toISOString(), `${year}-06-30T18:59:59.999Z`, "end of day, Almaty time");
      assert.equal(JSON.parse((await get("/api/me", userCookie)).body).ai_access.active, true);

      const revoke = await post(`/api/admin/users/${uid}/access`, { until: null }, admin);
      assert.equal(JSON.parse(revoke.body).ai_access.active, false);

      const log = JSON.parse((await get("/api/admin/audit", admin)).body);
      const actions = log.items.map((i: { action: string }) => i.action);
      assert.ok(actions.includes("ai_access_grant") && actions.includes("ai_access_revoke"), "access changes are audited");
      assert.throws(() => t.ctx.db.run("DELETE FROM audit_log"), /append-only/);
    } finally {
      await t.close();
    }
  });

  test("log out everywhere", async () => {
    const fresh = await makeEnv();
    try {
      const a = await adminLogin(fresh);
      const b = await adminLogin(fresh);
      const out = await fresh.app.inject({ method: "POST", url: "/api/admin/logout-all", headers: { origin: ORIGIN, cookie: a }, payload: {} });
      assert.equal(out.statusCode, 200);
      assert.equal((await fresh.app.inject({ method: "GET", url: "/api/admin/overview", headers: { cookie: b } })).statusCode, 404);
    } finally {
      await fresh.close();
    }
  });
});
