import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { proto, type WAMessage, type WASocket } from "baileys";
import { userSessionId } from "../src/wa/manager.ts";
import { adminLogin, cookieFrom, FAKE_JPEG, grantAccess, makeEnv, ORIGIN, registerUser, sleep, type TestEnv } from "./helpers.ts";

const CHECK = "http://check.localhost:5173";
const CHECK_HOST = { host: "check.localhost:5173", origin: CHECK };
let seq = 0;

describe("chief's read-only view (check.<domain>)", () => {
  let env: TestEnv;
  let admin: string;
  let manager: string; // the company's normal cabinet session
  let uid: number;
  let otherUid: number;
  let key: string;
  let chief: string;
  let sock: WASocket;

  const asChief = (url: string, cookie = chief) => env.app.inject({ method: "GET", url, headers: { host: CHECK_HOST.host, cookie } });
  const json = (r: { body: string }) => JSON.parse(r.body);
  const msg = (from: string, text: string, fromMe = false, id = `C${++seq}`) =>
    ({ key: { remoteJid: `${from}@s.whatsapp.net`, fromMe, id }, message: { conversation: text }, messageTimestamp: Math.floor(Date.now() / 1000), pushName: "Клиент" }) as WAMessage;
  const deliver = (m: WAMessage) => env.inbound.handle({ id: userSessionId(uid), userId: uid, sock }, { messages: [m], type: "notify" });
  const enable = (id: number, body: Record<string, unknown>) =>
    env.app.inject({ method: "POST", url: `/api/admin/users/${id}/check`, headers: { origin: ORIGIN, cookie: admin }, payload: body });
  const login = (k: string, headers: Record<string, string> = CHECK_HOST) =>
    env.app.inject({ method: "POST", url: "/api/check/login", headers, payload: { key: k } });

  before(async () => {
    env = await makeEnv();
    manager = await registerUser(env, "77030000001", "Шеф Компании");
    await registerUser(env, "77030000002", "Другая");
    uid = env.ctx.db.get<{ id: number }>("SELECT id FROM users WHERE phone = '77030000001'")!.id;
    otherUid = env.ctx.db.get<{ id: number }>("SELECT id FROM users WHERE phone = '77030000002'")!.id;
    grantAccess(env, "77030000001");
    env.ctx.db.run("UPDATE agent_settings SET reply_delay_sec = 1 WHERE user_id = ?", uid);
    env.wa.connected.add(userSessionId(uid));
    sock = { user: { id: "77070000001:2@s.whatsapp.net" } } as unknown as WASocket;
    admin = await adminLogin(env);
  });
  after(async () => env.close());

  test("the admin switches it on and gets an access key once", async () => {
    const year = new Date().getFullYear() + 1;
    const r = await enable(uid, { until: `${year}-12-31` });
    assert.equal(r.statusCode, 200);
    const body = json(r);
    key = body.key;
    assert.match(key, /^([A-HJ-NP-Z2-9]{4}-){5}[A-HJ-NP-Z2-9]{4}$/);
    assert.equal(body.check.active, true);
    const again = json(await enable(uid, { until: `${year}-12-31` }));
    assert.equal(again.key, null, "extending does not reveal or change the key");
    const overview = json(await env.app.inject({ method: "GET", url: "/api/admin/overview", headers: { cookie: admin } }));
    const row = overview.users.find((u: { id: number }) => u.id === uid);
    assert.equal(row.check.has_key, true);
    assert.ok(!JSON.stringify(overview).includes(key), "the key is never listed again");
    const audit = JSON.stringify(json(await env.app.inject({ method: "GET", url: "/api/admin/audit", headers: { cookie: admin } })));
    assert.ok(!audit.includes(key), "the key is not in the audit log");
  });

  test("sign-in works only on the check host and only with the right key", async () => {
    assert.equal((await login(key, { origin: ORIGIN })).statusCode, 404, "from the managers' host it does not exist");
    assert.equal((await login("AAAA-BBBB-CCCC-DDDD-EEEE-FFFF")).statusCode, 401);
    const ok = await login(key.toLowerCase().replace(/-/g, " "));
    assert.equal(ok.statusCode, 200, "spaces and case do not matter");
    chief = cookieFrom(ok, "alma_chk");
    const set = String([ok.headers["set-cookie"]].flat().find((c) => String(c).startsWith("alma_chk=")));
    assert.match(set, /Path=\/api\/check/);
    assert.match(set, /SameSite=Strict/);
    assert.match(set, /HttpOnly/);
    assert.equal(json(await asChief("/api/check/me")).company, "ТОО");
  });

  test("managers cannot get in, and the chief cannot act as a manager", async () => {
    assert.equal((await asChief("/api/check/me", manager)).statusCode, 401, "the cabinet session opens nothing here");
    assert.equal((await env.app.inject({ method: "GET", url: "/api/check/me", headers: { cookie: chief } })).statusCode, 404);
    const asManager = await env.app.inject({ method: "GET", url: "/api/chats", headers: { cookie: chief } });
    assert.equal(asManager.statusCode, 401, "the chief's key is not a cabinet login");
    const me = json(await env.app.inject({ method: "GET", url: "/api/me", headers: { cookie: manager } }));
    assert.ok(!JSON.stringify(me).includes("check"), "the cabinet does not even mention the feature");
  });

  test("watching changes nothing managers or customers see", async () => {
    await deliver(msg("77013000001", "Здравствуйте, нужна КОНСУЛЬТАЦИЯ по абонементу"));
    const chat = env.ctx.db.get<{ id: number }>("SELECT id FROM chats WHERE phone = '77013000001'")!;
    env.ctx.db.run("UPDATE chats SET needs_attention = 1 WHERE id = ?", chat.id);
    const before = env.ctx.db.get("SELECT unread_count, needs_attention, mode, is_resolved FROM chats WHERE id = ?", chat.id);
    assert.equal((await asChief(`/api/check/chats/${chat.id}`)).statusCode, 200);
    assert.equal((await asChief(`/api/check/chats/${chat.id}/messages`)).statusCode, 200);
    assert.equal((await asChief("/api/check/chats")).statusCode, 200);
    const after = env.ctx.db.get("SELECT unread_count, needs_attention, mode, is_resolved FROM chats WHERE id = ?", chat.id);
    assert.deepEqual(after, before);
    for (const [method, url] of [
      ["POST", `/api/check/chats/${chat.id}/messages`],
      ["POST", `/api/check/chats/${chat.id}/read`],
      ["POST", `/api/check/chats/${chat.id}/mode`],
    ] as const) {
      const r = await env.app.inject({ method, url, headers: { ...CHECK_HOST, cookie: chief }, payload: { body: "x", mode: "off" } });
      assert.equal(r.statusCode, 404, `${url}: no write endpoints in the chief's view`);
    }
  });

  test("deleted-for-everyone and edited messages: kept for the chief, hidden from managers and the AI", async () => {
    await sleep(2600); // let the bot answer the first message
    const callsBefore = env.ai.calls;
    const original = msg("77013000002", "Скидку 50% дадите? Иначе уйду к конкурентам");
    await deliver(original);
    await env.inbound.handleUpdate({ id: userSessionId(uid), userId: uid, sock }, [
      { key: { ...original.key }, update: { message: null, messageStubType: proto.WebMessageInfo.StubType.REVOKE } },
    ]);
    const edited = msg("77013000002", "Сколько стоит месяц?");
    await deliver(edited);
    await env.inbound.handleUpdate({ id: userSessionId(uid), userId: uid, sock }, [
      { key: { ...edited.key }, update: { message: { editedMessage: { message: { conversation: "Сколько стоит год?" } } } } },
    ]);
    await sleep(2600);
    const chat = env.ctx.db.get<{ id: number }>("SELECT id FROM chats WHERE phone = '77013000002'")!;

    const forManager = json(await env.app.inject({ method: "GET", url: `/api/chats/${chat.id}/messages`, headers: { cookie: manager } }));
    const delM = forManager.items.find((m: { deleted: boolean }) => m.deleted);
    assert.equal(delM.body, null, "managers only see «message deleted»");
    const editM = forManager.items.find((m: { edited: boolean }) => m.edited);
    assert.equal(editM.body, "Сколько стоит год?");
    assert.equal(editM.edits, undefined, "no edit history for managers");

    const forChief = json(await asChief(`/api/check/chats/${chat.id}/messages`));
    const delC = forChief.items.find((m: { deleted: boolean }) => m.deleted);
    assert.equal(delC.body, "Скидку 50% дадите? Иначе уйду к конкурентам");
    assert.equal(delC.deleted_by, "customer");
    const editC = forChief.items.find((m: { edited: boolean }) => m.edited);
    assert.deepEqual(editC.edits.map((e: { body: string }) => e.body), ["Сколько стоит месяц?"]);

    assert.equal(env.ai.calls, callsBefore + 1, "the bot answered once");
    const seen = JSON.stringify(env.ai.lastMessages);
    assert.doesNotMatch(seen, /Скидку 50%/, "deleted text never reaches the AI");
    assert.match(seen, /Сколько стоит год/, "the AI sees the edited text");
  });

  test("deleted media: the chief can open it, managers cannot", async () => {
    env.media.next = FAKE_JPEG;
    const photo = { key: { remoteJid: "77013000003@s.whatsapp.net", fromMe: false, id: `P${++seq}` }, message: { imageMessage: { mimetype: "image/jpeg", fileLength: 50 } }, messageTimestamp: Math.floor(Date.now() / 1000) } as WAMessage;
    await deliver(photo);
    await sleep(200);
    await env.inbound.handleUpdate({ id: userSessionId(uid), userId: uid, sock }, [{ key: photo.key, update: { message: null } }]);
    const m = env.ctx.db.get<{ id: number; chat_id: number }>("SELECT id, chat_id FROM messages WHERE wa_id = ?", photo.key.id!)!;
    const mgr = await env.app.inject({ method: "GET", url: `/api/chats/${m.chat_id}/messages/${m.id}/media`, headers: { cookie: manager } });
    assert.equal(mgr.statusCode, 404);
    const boss = await asChief(`/api/check/chats/${m.chat_id}/messages/${m.id}/media`);
    assert.equal(boss.statusCode, 200);
    assert.equal(boss.headers["content-type"], "image/jpeg");
  });

  test("full-text search: any case, Kazakh too, only this company, injection-safe", async () => {
    await deliver(msg("77013000004", "Ертең кешке бағасы қанша болады?"));
    env.ctx.db.run(
      "INSERT INTO chats (user_id, jid, phone, last_message_at, created_at) VALUES (?, 'x@s.whatsapp.net', '77099999999', 1, 1)",
      otherUid,
    );
    const otherChat = env.ctx.db.get<{ id: number }>("SELECT id FROM chats WHERE user_id = ?", otherUid)!;
    env.ctx.db.run(
      "INSERT INTO messages (chat_id, user_id, direction, source, kind, body, created_at) VALUES (?, ?, 'in', 'customer', 'text', 'консультация чужой компании', 1)",
      otherChat.id,
      otherUid,
    );
    const ru = json(await asChief(`/api/check/search?q=${encodeURIComponent("консультац")}`));
    assert.equal(ru.items.length, 1, "prefix + case-insensitive, other company excluded");
    assert.match(ru.items[0].snippet, /\u0002КОНСУЛЬТАЦИЯ\u0003/);
    const kk = json(await asChief(`/api/check/search?q=${encodeURIComponent("БАҒАСЫ")}`));
    assert.equal(kk.items.length, 1);
    const evil = await asChief(`/api/check/search?q=${encodeURIComponent('" OR * NEAR( ) -- ')}`);
    assert.equal(evil.statusCode, 200);
  });

  test("call log: missed and answered", async () => {
    const call = (id: string, status: string) =>
      env.inbound.handleCall({ id: userSessionId(uid), userId: uid, sock }, [
        { id, from: "77013000001@s.whatsapp.net", chatId: "77013000001@s.whatsapp.net", status, date: new Date(), offline: false, isVideo: false } as never,
      ]);
    await call("CALL1", "offer");
    await call("CALL1", "terminate");
    await call("CALL2", "offer");
    await call("CALL2", "accept");
    await call("CALL2", "terminate");
    const calls = json(await asChief("/api/check/calls")).items;
    assert.equal(calls.find((c: { id: number; outcome: string }) => c.outcome === "missed")?.name, "Клиент");
    assert.equal(calls.filter((c: { outcome: string }) => c.outcome === "answered").length, 1);
    const summary = json(await asChief("/api/check/summary?days=7"));
    assert.equal(summary.calls.missed, 1);
    assert.equal(summary.deleted.customer, 2);
  });

  test("another company's chats are out of reach (IDOR)", async () => {
    const other = env.ctx.db.get<{ id: number }>("SELECT id FROM chats WHERE user_id = ?", otherUid)!;
    for (const url of [`/api/check/chats/${other.id}`, `/api/check/chats/${other.id}/messages`, `/api/check/chats/${other.id}/profile`]) {
      assert.equal((await asChief(url)).statusCode, 404, url);
    }
  });

  test("rotating the key or switching off signs the chief out", async () => {
    const year = new Date().getFullYear() + 1;
    const rotated = json(await enable(uid, { until: `${year}-12-31`, rotate: true }));
    assert.notEqual(rotated.key, key);
    assert.equal((await asChief("/api/check/me")).statusCode, 401, "old session is gone");
    assert.equal((await login(key)).statusCode, 401, "old key is dead");
    chief = cookieFrom(await login(rotated.key), "alma_chk");
    assert.equal((await asChief("/api/check/me")).statusCode, 200);
    env.ctx.db.run("UPDATE users SET check_until = ? WHERE id = ?", Date.now() - 1000, uid);
    assert.equal((await asChief("/api/check/me")).statusCode, 401, "expired access closes the view");
    await enable(uid, { until: null });
    assert.equal((await login(rotated.key)).statusCode, 401);
  });

  test("guessing keys gets locked out", async () => {
    const fresh = await makeEnv();
    try {
      for (let i = 0; i < 10; i++) {
        const r = await fresh.app.inject({ method: "POST", url: "/api/check/login", headers: CHECK_HOST, payload: { key: `WRONG-KEY-${i}AAA-BBBB-CCCC` } });
        assert.equal(r.statusCode, 401);
      }
      const r = await fresh.app.inject({ method: "POST", url: "/api/check/login", headers: CHECK_HOST, payload: { key: "WRONG-KEY-XAAA-BBBB-CCCC" } });
      assert.equal(r.statusCode, 429);
    } finally {
      await fresh.close();
    }
  });
});

describe("full history import", () => {
  test("everything the phone sends, no per-chat cap, no age limit by default", async () => {
    const env = await makeEnv({ historyDays: 0 });
    try {
      await registerUser(env, "77030000009");
      const uid = env.ctx.db.get<{ id: number }>("SELECT id FROM users WHERE phone = '77030000009'")!.id;
      const sock = { user: { id: "77070000009:1@s.whatsapp.net" } } as unknown as WASocket;
      const start = Math.floor(Date.now() / 1000) - 3 * 365 * 86400; // three years back
      const messages = Array.from({ length: 1200 }, (_, i) => ({
        key: { remoteJid: "77014000001@s.whatsapp.net", fromMe: i % 3 === 0, id: `HX${i}` },
        message: { conversation: `сообщение ${i}` },
        messageTimestamp: start + i * 3600,
      })) as WAMessage[];
      await env.inbound.handleHistory({ id: userSessionId(uid), userId: uid, sock }, { chats: [], contacts: [], messages, isLatest: true });
      const n = env.ctx.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM messages WHERE user_id = ?", uid)!.n;
      assert.equal(n, 1200);
      assert.equal(env.ai.calls, 0);
    } finally {
      await env.close();
    }
  });
});
