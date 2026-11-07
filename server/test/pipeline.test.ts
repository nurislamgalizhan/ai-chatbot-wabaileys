import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";
import type { WAMessage, WASocket } from "baileys";
import { userSessionId } from "../src/wa/manager.ts";
import { FAKE_HTML, FAKE_JPEG, FAKE_OGG, grantAccess, makeEnv, ORIGIN, registerUser, sleep, type TestEnv } from "./helpers.ts";

const BUSINESS = "77070000000";
let seq = 0;

function waMsg(from: string, text: string, fromMe = false, id = `M${++seq}`): WAMessage {
  return {
    key: { remoteJid: `${from}@s.whatsapp.net`, fromMe, id },
    message: { conversation: text },
    messageTimestamp: Math.floor(Date.now() / 1000),
    pushName: fromMe ? undefined : "Клиент",
  } as WAMessage;
}

describe("auto-reply pipeline", () => {
  let env: TestEnv;
  let userId: number;
  let cookie: string;
  let sock: WASocket;
  const deliver = (m: WAMessage) =>
    env.inbound.handle({ id: userSessionId(userId), userId, sock }, { messages: [m], type: "notify" });

  before(async () => {
    env = await makeEnv();
    cookie = await registerUser(env, "77019990000");
    userId = env.ctx.db.get<{ id: number }>("SELECT id FROM users WHERE phone = '77019990000'")!.id;
    grantAccess(env, "77019990000");
    env.ctx.db.run("UPDATE agent_settings SET reply_delay_sec = 1, operator_pause_min = 30 WHERE user_id = ?", userId);
    env.wa.connected.add(userSessionId(userId));
    sock = { user: { id: `${BUSINESS}:3@s.whatsapp.net` } } as unknown as WASocket;
  });
  after(async () => env.close());
  beforeEach(() => {
    env.wa.sent = [];
    env.ai.calls = 0;
    env.ai.handoff = false;
  });

  test("a burst of messages gets one answer; duplicates are ignored", async () => {
    const first = waMsg("77011110001", "Здравствуйте");
    await deliver(first);
    await deliver(first); // WhatsApp re-delivery
    await deliver(waMsg("77011110001", "сколько стоит абонемент?"));
    await sleep(3500);
    assert.equal(env.ai.calls, 1, "one model call for the burst");
    assert.equal(env.wa.sent.length, 1);
    assert.equal(env.wa.sent[0]!.jid, "77011110001@s.whatsapp.net");
    const rows = env.ctx.db.all<{ source: string; status: string }>(
      "SELECT m.source, m.status FROM messages m JOIN chats c ON c.id = m.chat_id WHERE c.phone = '77011110001' ORDER BY m.id",
    );
    assert.deepEqual(
      rows.map((r) => r.source),
      ["customer", "customer", "ai"],
    );
    assert.equal(rows.at(-1)!.status, "sent");

    // The echo of our own message must not be treated as an operator reply.
    await deliver(waMsg("77011110001", env.ai.reply, true, env.wa.sent[0]!.id));
    const chat = env.ctx.db.get<{ mode: string }>("SELECT mode FROM chats WHERE phone = '77011110001'")!;
    assert.equal(chat.mode, "auto");
  });

  test("a manager replying from the phone pauses the AI in that chat", async () => {
    await deliver(waMsg("77011110002", "Добрый день"));
    await deliver(waMsg("77011110002", "Здравствуйте! Я менеджер, сейчас подскажу", true));
    await sleep(3000);
    assert.equal(env.ai.calls, 0, "AI stays quiet after the manager stepped in");
    const chat = env.ctx.db.get<{ mode: string; paused_until: number }>(
      "SELECT mode, paused_until FROM chats WHERE phone = '77011110002'",
    )!;
    assert.equal(chat.mode, "paused");
    assert.ok(chat.paused_until > Date.now() + 25 * 60_000);

    await deliver(waMsg("77011110002", "а парковка есть?"));
    await sleep(2500);
    assert.equal(env.ai.calls, 0, "still paused for the next customer message");
  });

  test("handoff flags the chat for a manager", async () => {
    env.ai.handoff = true;
    env.ai.reply = "Передаю ваш вопрос менеджеру";
    await deliver(waMsg("77011110003", "Позовите человека"));
    await sleep(3500);
    const chat = env.ctx.db.get<{ needs_attention: number; mode: string }>(
      "SELECT needs_attention, mode FROM chats WHERE phone = '77011110003'",
    )!;
    assert.equal(chat.needs_attention, 1);
    assert.equal(chat.mode, "paused");
  });

  test("global switch off: nobody is answered", async () => {
    await env.app.inject({
      method: "POST",
      url: "/api/agent/toggle",
      headers: { cookie, origin: ORIGIN },
      payload: { enabled: false },
    });
    await deliver(waMsg("77011110004", "Алло"));
    await sleep(2500);
    assert.equal(env.ai.calls, 0);
    await env.app.inject({
      method: "POST",
      url: "/api/agent/toggle",
      headers: { cookie, origin: ORIGIN },
      payload: { enabled: true },
    });
  });

  test("groups and stickers never create chats", async () => {
    const before = env.ctx.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM chats")!.n;
    await env.inbound.handle(
      { id: userSessionId(userId), userId, sock },
      {
        type: "notify",
        messages: [
          { key: { remoteJid: "123456@g.us", id: "G1", fromMe: false }, message: { conversation: "hi" }, messageTimestamp: Date.now() / 1000 } as WAMessage,
          { key: { remoteJid: "77011110005@s.whatsapp.net", id: "S1", fromMe: false }, message: { stickerMessage: {} }, messageTimestamp: Date.now() / 1000 } as WAMessage,
        ],
      },
    );
    const afterCount = env.ctx.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM chats")!.n;
    assert.equal(afterCount, before);
  });

  test("operator message from the panel is sent and pauses AI", async () => {
    await deliver(waMsg("77011110006", "Вопрос"));
    const chat = env.ctx.db.get<{ id: number }>("SELECT id FROM chats WHERE phone = '77011110006'")!;
    const r = await env.app.inject({
      method: "POST",
      url: `/api/chats/${chat.id}/messages`,
      headers: { cookie, origin: ORIGIN },
      payload: { body: "Отвечу сам" },
    });
    assert.equal(r.statusCode, 200);
    await sleep(2500);
    assert.equal(env.ai.calls, 0, "the pending AI reply was cancelled");
    assert.equal(env.wa.sent.at(-1)!.text, "Отвечу сам");
  });
});

describe("media, voice, access and history", () => {
  let env: TestEnv;
  let userId: number;
  let cookie: string;
  let other: string;
  let sock: WASocket;
  const deliver = (m: WAMessage) =>
    env.inbound.handle({ id: userSessionId(userId), userId, sock }, { messages: [m], type: "notify" });
  const media = (from: string, message: Record<string, unknown>, id = `MM${++seq}`): WAMessage =>
    ({ key: { remoteJid: `${from}@s.whatsapp.net`, fromMe: false, id }, message, messageTimestamp: Math.floor(Date.now() / 1000), pushName: "Клиент" }) as WAMessage;
  const chatOf = (phone: string) => env.ctx.db.get<{ id: number; needs_attention: number }>("SELECT id, needs_attention FROM chats WHERE phone = ?", phone)!;
  const allText = () => JSON.stringify(env.ai.lastMessages);

  before(async () => {
    env = await makeEnv();
    cookie = await registerUser(env, "77019990001");
    other = await registerUser(env, "77019990002", "Чужой");
    userId = env.ctx.db.get<{ id: number }>("SELECT id FROM users WHERE phone = '77019990001'")!.id;
    grantAccess(env, "77019990001");
    env.ctx.db.run("UPDATE agent_settings SET reply_delay_sec = 1 WHERE user_id = ?", userId);
    env.wa.connected.add(userSessionId(userId));
    sock = { user: { id: `${BUSINESS}:3@s.whatsapp.net` } } as unknown as WASocket;
  });
  after(async () => env.close());
  beforeEach(() => {
    env.ai.calls = 0;
    env.ai.lastMessages = [];
  });

  test("a photo alone is shown in the chat, never sent to the AI", async () => {
    env.media.next = FAKE_JPEG;
    await deliver(media("77012000001", { imageMessage: { mimetype: "image/jpeg", fileLength: FAKE_JPEG.length } }));
    await sleep(2600);
    assert.equal(env.ai.calls, 0, "no blind answer to a photo");
    const chat = chatOf("77012000001");
    assert.equal(chat.needs_attention, 1, "a manager is asked to look at it");
    const msgs = JSON.parse((await env.app.inject({ method: "GET", url: `/api/chats/${chat.id}/messages`, headers: { cookie } })).body);
    const photo = msgs.items[0];
    assert.equal(photo.kind, "image");
    assert.equal(photo.media_state, "stored");
    const file = await env.app.inject({ method: "GET", url: `/api/chats/${chat.id}/messages/${photo.id}/media`, headers: { cookie } });
    assert.equal(file.statusCode, 200);
    assert.equal(file.headers["content-type"], "image/jpeg");
    assert.match(String(file.headers["content-security-policy"]), /sandbox/);
    assert.equal(file.rawPayload.length, FAKE_JPEG.length);
    const ranged = await env.app.inject({ method: "GET", url: `/api/chats/${chat.id}/messages/${photo.id}/media`, headers: { cookie, range: "bytes=0-9" } });
    assert.equal(ranged.statusCode, 206);
    assert.equal(ranged.rawPayload.length, 10);
    const stranger = await env.app.inject({ method: "GET", url: `/api/chats/${chat.id}/messages/${photo.id}/media`, headers: { cookie: other } });
    assert.equal(stranger.statusCode, 404, "another account cannot fetch the file");
  });

  test("photo with a caption: the AI sees only a marker and the caption", async () => {
    env.media.next = FAKE_JPEG;
    await deliver(media("77012000002", { imageMessage: { mimetype: "image/jpeg", caption: "такой есть в наличии?", fileLength: 10 } }));
    await sleep(2600);
    assert.equal(env.ai.calls, 1);
    const seen = allText();
    assert.match(seen, /клиент отправил фото/);
    assert.match(seen, /такой есть в наличии/);
    assert.doesNotMatch(seen, /image_url|base64|\/9j\//, "no image bytes reach the model");
  });

  test("documents are downloads, whatever the sender claims", async () => {
    env.media.next = FAKE_HTML;
    await deliver(media("77012000003", { documentMessage: { mimetype: "text/html", fileName: "../../evil\".html", fileLength: FAKE_HTML.length } }));
    await sleep(300);
    const chat = chatOf("77012000003");
    const msgs = JSON.parse((await env.app.inject({ method: "GET", url: `/api/chats/${chat.id}/messages`, headers: { cookie } })).body);
    const doc = msgs.items[0];
    const file = await env.app.inject({ method: "GET", url: `/api/chats/${chat.id}/messages/${doc.id}/media`, headers: { cookie } });
    assert.equal(file.statusCode, 200);
    assert.equal(file.headers["content-type"], "application/octet-stream");
    assert.match(String(file.headers["content-disposition"]), /^attachment;/);
    assert.doesNotMatch(String(file.headers["content-disposition"]), /\.\.\/|"/);
  });

  test("voice notes are transcribed first, then answered", async () => {
    env.media.next = FAKE_OGG;
    env.ai.transcript = "Сәлеметсіз бе, бағасы қанша?";
    const before = env.ai.transcribeCalls;
    await deliver(media("77012000004", { audioMessage: { mimetype: "audio/ogg; codecs=opus", ptt: true, seconds: 4, fileLength: FAKE_OGG.length } }));
    await sleep(2600);
    assert.equal(env.ai.transcribeCalls, before + 1);
    assert.equal(env.ai.calls, 1);
    assert.match(allText(), /голосовое сообщение, расшифровка.*бағасы қанша/);
    const chat = chatOf("77012000004");
    const msgs = JSON.parse((await env.app.inject({ method: "GET", url: `/api/chats/${chat.id}/messages`, headers: { cookie } })).body);
    assert.equal(msgs.items[0].transcript, "Сәлеметсіз бе, бағасы қанша?");
    const audio = await env.app.inject({ method: "GET", url: `/api/chats/${chat.id}/messages/${msgs.items[0].id}/media`, headers: { cookie } });
    assert.equal(audio.headers["content-type"], "audio/ogg", "playable in the chat");
  });

  test("without AI access the bot is silent and the test chat is closed", async () => {
    const before = env.ai.transcribeCalls;
    env.ctx.db.run("UPDATE users SET ai_access_until = ? WHERE id = ?", Date.now() - 1000, userId);
    await deliver(waMsg("77012000005", "Здравствуйте"));
    env.media.next = FAKE_OGG;
    await deliver(media("77012000005", { audioMessage: { mimetype: "audio/ogg", ptt: true, seconds: 3, fileLength: 10 } }));
    await sleep(2600);
    assert.equal(env.ai.calls, 0);
    assert.equal(env.ai.transcribeCalls, before, "no paid transcription without access");
    const sandbox = await env.app.inject({
      method: "POST",
      url: "/api/agent/test",
      headers: { cookie, origin: ORIGIN },
      payload: { messages: [{ role: "user", content: "Привет" }] },
    });
    assert.equal(sandbox.statusCode, 403);
    grantAccess(env, "77019990001");
  });

  test("history is imported silently and media loads on demand", async () => {
    const old = Math.floor(Date.now() / 1000) - 3 * 86400;
    await env.inbound.handleHistory(
      { id: userSessionId(userId), userId, sock },
      {
        chats: [],
        contacts: [{ id: "77012000006@s.whatsapp.net", notify: "Гүлнар" }],
        messages: [
          { key: { remoteJid: "77012000006@s.whatsapp.net", fromMe: false, id: "H1" }, message: { conversation: "Добрый день, вы работаете в субботу?" }, messageTimestamp: old },
          { key: { remoteJid: "77012000006@s.whatsapp.net", fromMe: true, id: "H2" }, message: { conversation: "Да, с 10 до 18" }, messageTimestamp: old + 60 },
          { key: { remoteJid: "77012000006@s.whatsapp.net", fromMe: false, id: "H3" }, message: { imageMessage: { mimetype: "image/jpeg", fileLength: 100 } }, messageTimestamp: old + 120 },
          { key: { remoteJid: "120363@g.us", fromMe: false, id: "HG" }, message: { conversation: "group" }, messageTimestamp: old },
          { key: { remoteJid: "77012000006@s.whatsapp.net", fromMe: false, id: "HOLD" }, message: { conversation: "очень старое" }, messageTimestamp: old - 365 * 86400 },
        ] as WAMessage[],
        isLatest: true,
      },
    );
    await sleep(1500);
    assert.equal(env.ai.calls, 0, "history never triggers the bot");
    const chat = env.ctx.db.get<{ id: number; name: string; unread_count: number; mode: string }>(
      "SELECT id, name, unread_count, mode FROM chats WHERE phone = '77012000006'",
    )!;
    assert.equal(chat.name, "Гүлнар");
    assert.equal(chat.unread_count, 0);
    assert.equal(chat.mode, "auto", "history does not pause the AI");
    const msgs = JSON.parse((await env.app.inject({ method: "GET", url: `/api/chats/${chat.id}/messages`, headers: { cookie } })).body);
    assert.deepEqual(
      msgs.items.map((m: { body: string | null; kind: string }) => m.body ?? m.kind),
      ["Добрый день, вы работаете в субботу?", "Да, с 10 до 18", "image"],
      "older than HISTORY_DAYS and groups are skipped; order by time",
    );
    const img = msgs.items[2];
    assert.equal(img.media_state, "lazy");
    env.media.next = FAKE_JPEG;
    const file = await env.app.inject({ method: "GET", url: `/api/chats/${chat.id}/messages/${img.id}/media`, headers: { cookie } });
    assert.equal(file.statusCode, 200, "downloaded from WhatsApp when first opened");

    const more = await env.app.inject({ method: "POST", url: `/api/chats/${chat.id}/history`, headers: { cookie, origin: ORIGIN }, payload: {} });
    assert.equal(more.statusCode, 200);
    assert.equal(env.wa.historyRequests.length, 1, "older messages are requested from the phone");
  });
});
