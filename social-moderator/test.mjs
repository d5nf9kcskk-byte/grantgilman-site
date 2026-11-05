// Offline checks with fake platform APIs. Run: node test.mjs
import assert from "node:assert/strict";
import worker, { runPlatform, classify } from "./src/index.js";

if (!crypto.subtle.timingSafeEqual) {
  crypto.subtle.timingSafeEqual = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
}

function makeEnv() {
  const store = new Map();
  return {
    SETUP_KEY: "k123",
    ORIGIN: "https://moderator.example",
    store,
    KV: {
      get: async (k) => store.get(k) ?? null,
      put: async (k, v) => void store.set(k, v),
      delete: async (k) => void store.delete(k),
    },
    aiCalls: 0,
    AI: {
      async run(model, { messages }) {
        this.parent.aiCalls++;
        const items = JSON.parse(messages[1].content);
        const results = items.map((c) => ({ id: c.id, action: /bad|meh|spam/i.test(c.text) ? "HIDE" : "KEEP", reason: "test" }));
        return { response: JSON.stringify({ results }) };
      },
    },
  };
}
const J = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json" } });
let calls = [];
let routes = [];
globalThis.fetch = async (url, init = {}) => {
  const u = String(url);
  calls.push({ url: u, method: init.method || "GET", body: init.body });
  for (const [re, fn] of routes) if (re.test(u)) return fn(u, init);
  throw new Error("unexpected fetch " + u);
};
const put = (env, k, v) => env.store.set(k, JSON.stringify(v));
const get = (env, k) => JSON.parse(env.store.get(k) ?? "null");

// ---------- YouTube ----------
{
  const env = makeEnv();
  env.AI.parent = env;
  put(env, "cfg:google", { client_id: "cid", client_secret: "cs" });
  put(env, "tok:google", { refresh_token: "rt", email: "me@gmail.com", channel_id: "OWNER", channel_title: "Grant" });
  const c = (id, text, author = "U1") => ({ id, snippet: { textOriginal: text, authorDisplayName: "x", authorChannelId: { value: author }, videoId: "v1", moderationStatus: "published" } });
  calls = [];
  routes = [
    [/oauth2\.googleapis\.com\/token/, () => J({ access_token: "at" })],
    [/commentThreads/, () => J({ items: [
      { id: "T1", snippet: { topLevelComment: c("A", "Bravo!"), totalReplyCount: 2 }, replies: { comments: [c("B", "meh"), c("O", "thanks all", "OWNER")] } },
      { id: "T2", snippet: { topLevelComment: c("C", "this is bad"), totalReplyCount: 7 }, replies: { comments: [c("D", "great")] } },
    ] })],
    [/\/comments\?/, () => J({ items: [c("D", "great"), c("E", "spam link")] })],
    [/setModerationStatus/, () => new Response(null, { status: 204 })],
  ];
  const r = await runPlatform(env, "youtube");
  assert.deepEqual(r.hidden.map((h) => h.text).sort(), ["meh", "spam link", "this is bad"]);
  const hideCall = calls.find((x) => x.url.includes("setModerationStatus"));
  assert.match(hideCall.url, /moderationStatus=heldForReview/);
  assert.deepEqual(new URL(hideCall.url).searchParams.get("id").split(",").sort(), ["B", "C", "E"]);
  assert.ok(!r.hidden.some((h) => h.text === "thanks all"), "owner comment never judged");
  assert.equal(get(env, "state:youtube").backfill, "done");
  assert.equal(get(env, "status:youtube").hidden, 3);

  // Second run: same comments come back, nothing new to judge or hide.
  env.aiCalls = 0;
  calls = [];
  const r2 = await runPlatform(env, "youtube");
  assert.equal(r2.checked, 0);
  assert.equal(env.aiCalls, 0);
  assert.ok(!calls.some((x) => x.url.includes("setModerationStatus")));
  assert.ok(!calls.some((x) => x.url.includes("/comments?")), "reply count unchanged, no reply fetch");
  console.log("youtube ok");
}

// ---------- Facebook + Instagram ----------
{
  const env = makeEnv();
  env.AI.parent = env;
  put(env, "tok:meta", { pages: [{ id: "PAGE", name: "Grant Gilman", token: "ptok" }], igs: [{ id: "IG", username: "grantgilman", token: "ptok" }] });
  calls = [];
  routes = [
    [/\/PAGE\/feed/, () => J({ data: [{ id: "P1", permalink_url: "fb/p1", comments: { data: [
      { id: "F1", message: "bad tempo", from: { id: "X", name: "Troll" } },
      { id: "F2", message: "Beautiful", from: { id: "Y", name: "Fan" } },
      { id: "F3", message: "bad joke from me", from: { id: "PAGE", name: "Grant" } },
      { id: "F4", message: "meh", is_hidden: true },
    ] } }] })],
    [/\/IG\/media/, () => J({ data: [{ id: "M1", permalink: "ig/m1", comments: { data: [
      { id: "I1", text: "So good", username: "fan", replies: { data: [{ id: "I2", text: "meh", username: "hater" }] } },
    ] } }] })],
    [/graph\.facebook\.com\/v23\.0$/, (u, init) => {
      const batch = JSON.parse(init.body.get("batch"));
      assert.deepEqual(batch.map((x) => x.relative_url).sort(), ["F1?is_hidden=true", "I2?hide=true"]);
      return J(batch.map((x) => (x.relative_url.startsWith("F1") ? { code: 200, body: '{"success":true}' } : { code: 400, body: "{}" })));
    }],
  ];
  const r = await runPlatform(env, "meta");
  assert.deepEqual(r.hidden.map((h) => h.text), ["bad tempo"]);
  assert.deepEqual(r.failed.map((h) => h.text), ["meh"]);
  const seen = get(env, "seen:meta");
  assert.ok(seen.F1 && seen.F2 && seen.I1 && seen.F3, "judged + owner marked seen");
  assert.ok(!seen.I2, "failed hide retried next run");
  assert.ok(!JSON.stringify(r).includes("ptok"), "tokens never leave the worker");
  console.log("meta ok");
}

// ---------- X ----------
{
  const env = makeEnv();
  env.AI.parent = env;
  put(env, "cfg:x", { client_id: "xc", client_secret: "xs" });
  put(env, "tok:x", { refresh_token: "old", user_id: "1", username: "grant" });
  calls = [];
  routes = [
    [/api\.x\.com\/2\/oauth2\/token/, () => J({ access_token: "xa", refresh_token: "new" })],
    [/search\/recent/, (u) => {
      const q = new URL(u).searchParams.get("query");
      assert.equal(q, "to:grant is:reply -from:grant");
      return J({ data: [
        { id: "100", text: "@grant meh", author_id: "9" },
        { id: "101", text: "@grant bad take", author_id: "9" },
        { id: "102", text: "@grant wonderful", author_id: "8" },
      ], includes: { users: [{ id: "9", username: "hater" }, { id: "8", username: "fan" }] }, meta: { newest_id: "102" } });
    }],
    [/tweets\/100\/hidden/, () => J({ data: { hidden: true } })],
    [/tweets\/101\/hidden/, () => J({ title: "Forbidden" }, 403)],
  ];
  const r = await runPlatform(env, "x");
  assert.equal(get(env, "tok:x").refresh_token, "new", "rotated refresh token saved");
  assert.deepEqual(r.hidden.map((h) => h.text), ["@grant meh"]);
  assert.equal(get(env, "state:x").since_id, "102");
  assert.ok(get(env, "seen:x")["101"], "unhideable reply not retried forever");
  console.log("x ok");
}

// ---------- alerting: two failures in a row send one email ----------
{
  const env = makeEnv();
  env.AI.parent = env;
  put(env, "cfg:google", { client_id: "cid", client_secret: "cs" });
  put(env, "tok:google", { refresh_token: "rt", email: "me@gmail.com", channel_id: "OWNER", channel_title: "Grant" });
  put(env, "tok:meta", { pages: [{ id: "PAGE", name: "G", token: "dead" }], igs: [] });
  calls = [];
  routes = [
    [/\/PAGE\/feed/, () => J({ error: { message: "Session expired", code: 190 } }, 400)],
    [/oauth2\.googleapis\.com\/token/, () => J({ access_token: "at" })],
    [/gmail\.googleapis\.com/, () => J({ id: "m" })],
  ];
  await runPlatform(env, "meta");
  assert.ok(!calls.some((x) => x.url.includes("gmail")), "no email on first failure");
  await runPlatform(env, "meta");
  await runPlatform(env, "meta");
  assert.equal(calls.filter((x) => x.url.includes("gmail")).length, 1, "exactly one email");
  assert.equal(get(env, "status:meta").fails, 3);
  console.log("alert ok");
}

// ---------- HTTP routes ----------
{
  const env = makeEnv();
  env.AI.parent = env;
  const req = (path, init) => worker.fetch(new Request("https://moderator.example" + path, init), env);
  assert.equal((await req("/setup")).status, 404);
  assert.equal((await req("/setup?key=wrong")).status, 404);
  const s = await req("/setup?key=k123");
  assert.equal(s.status, 200);
  assert.match(await s.text(), /callback\/google/);
  const form = new FormData();
  form.set("p", "google");
  form.set("client_id", "abc");
  form.set("client_secret", "shh");
  assert.equal((await req("/setup?key=k123", { method: "POST", body: form })).status, 200);
  assert.deepEqual(get(env, "cfg:google"), { client_id: "abc", client_secret: "shh" });
  const c = await req("/connect/google?key=k123");
  assert.equal(c.status, 302);
  const loc = new URL(c.headers.get("location"));
  assert.equal(loc.searchParams.get("redirect_uri"), "https://moderator.example/callback/google");
  assert.equal(loc.searchParams.get("access_type"), "offline");
  assert.equal((await req("/callback/google?state=nope&code=x")).status, 400);
  const x = new FormData();
  x.set("p", "x");
  x.set("client_id", "xc");
  x.set("client_secret", "xs");
  await req("/setup?key=k123", { method: "POST", body: x });
  const xc = new URL((await req("/connect/x?key=k123")).headers.get("location"));
  assert.equal(xc.searchParams.get("code_challenge_method"), "S256");
  assert.ok(xc.searchParams.get("code_challenge").length >= 43);
  console.log("routes ok");
}

// ---------- classifier keeps going when the model returns junk ----------
{
  const env = makeEnv();
  env.AI = { run: async () => ({ response: "sorry, no JSON here" }) };
  const v = await classify(env, [{ id: "a", text: "hello" }, { id: "b", text: "" }]);
  assert.equal(v.get("a"), undefined, "unjudged, retried next run");
  assert.equal(v.get("b"), "KEEP", "empty text kept");
  console.log("classifier fallback ok");
}
console.log("all passed");
