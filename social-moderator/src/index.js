/*
 * Comment cleanup for Grant Gilman's social accounts.
 *
 * Every 3 hours it reads new comments on YouTube, Facebook, Instagram and X,
 * asks Workers AI which ones are even a little negative, and hides those:
 *   YouTube   -> "held for review" (Studio > Comments > Held for review to undo)
 *   Facebook  -> hidden comment (still visible to the commenter and their friends)
 *   Instagram -> hidden comment (Instagram > hidden comments to undo)
 *   X         -> hidden reply ("View hidden replies" to undo)
 * Nothing is ever deleted. TikTok has no API for this and is not covered.
 *
 * Setup and status page: <ORIGIN>/setup?key=<SETUP_KEY>
 * If a platform fails twice in a row, an email goes to the Gmail account
 * that owns the YouTube channel.
 *
 * Deploy from this folder with `npx wrangler deploy`. Secret: SETUP_KEY.
 */

const MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";
const GRAPH = "https://graph.facebook.com/v23.0";
const YT = "https://www.googleapis.com/youtube/v3";
const XAPI = "https://api.x.com/2";
const SEEN_DAYS = 60;
// Workers Free allows 50 outside fetches per run. Keep a few spare for the alert email.
const BUDGET = 44;

export const CRONS = {
  "5 */3 * * *": "youtube",
  "25 */3 * * *": "meta",
  "45 */3 * * *": "x",
};

const META_SCOPES = [
  "pages_show_list",
  "pages_read_engagement",
  "pages_read_user_content",
  "pages_manage_engagement",
  "instagram_basic",
  "instagram_manage_comments",
  "business_management",
].join(",");

export const PROMPT = `You moderate comments on the social media of Grant Gilman, an orchestra conductor. The owner wants ONLY positive or neutral comments visible. Decide for each comment: KEEP or HIDE.

HIDE anything even a little negative:
- any criticism of the playing, conducting, tempo, tuning, sound, audio/video quality, interpretation, piece choice, or production, even mild or polite ("a bit slow for my taste", "audio cuts out at 5:12")
- sarcasm, eye-roll emojis, backhanded compliments ("not bad for students", "so bad it's good"), praise of one section that implies the rest were weak ("the woodwinds carried this")
- unflattering comparisons to other orchestras, conductors, or recordings
- rudeness, mockery, trolling, arguments, politics
- spam, scams, links, self-promotion ("check out my channel")
- emoji-only comments with negative emojis (🙄 👎 🤮 😴 🥱 💤)

KEEP:
- praise of any kind. Music and internet slang is praise: "filthy", "sick", "insane", "unreal", "criminally underrated", "this destroyed me", "I'm crying", "illegal how good this is", "goosebumps"
- neutral comments: questions, timestamps, "what piece is this", tagging friends, "I was there"
- emoji-only comments with positive emojis

Judge comments in other languages by their meaning. If a comment is genuinely ambiguous between praise and criticism, HIDE it.

Reply with JSON only: {"results":[{"id":"<id>","action":"KEEP"|"HIDE","reason":"<5 words max>"}]} with one entry per input comment, same ids.`;

class OutOfBudget extends Error {}
class AuthProblem extends Error {}

// ---------- small helpers ----------

export function makeBudget(n, fetcher = (...a) => fetch(...a)) {
  return {
    left: n,
    async fetch(url, init) {
      if (this.left <= 0) throw new OutOfBudget("fetch budget used up");
      this.left--;
      return fetcher(url, init);
    },
  };
}

const getJ = async (env, k) => {
  const v = await env.KV.get(k);
  return v ? JSON.parse(v) : null;
};
const putJ = (env, k, v, o) => env.KV.put(k, JSON.stringify(v), o);
const today = () => Math.floor(Date.now() / 86400000);
const qs = (o) => new URLSearchParams(Object.entries(o).filter(([, v]) => v != null && v !== "")).toString();
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const rand = (n) => [...crypto.getRandomValues(new Uint8Array(n))].map((b) => b.toString(16).padStart(2, "0")).join("");
const b64url = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const b64urlText = (s) => b64url(new TextEncoder().encode(s));
const sha256 = (s) => crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));

async function loadSeen(env, p) {
  const seen = (await getJ(env, "seen:" + p)) || {};
  const cutoff = today() - SEEN_DAYS;
  for (const k in seen) if (seen[k] < cutoff) delete seen[k];
  return seen;
}

function keyOk(env, given) {
  if (!env.SETUP_KEY || !given) return false;
  const a = new TextEncoder().encode(given);
  const b = new TextEncoder().encode(env.SETUP_KEY);
  return a.length === b.length && crypto.subtle.timingSafeEqual(a, b);
}

// ---------- classifier ----------

// items: [{id, text}] -> Map(id -> "KEEP" | "HIDE"). Ids missing from the map were not judged.
export async function classify(env, items) {
  const verdicts = new Map();
  const judge = [];
  for (const c of items) {
    if (!c.text || !c.text.trim()) verdicts.set(c.id, "KEEP");
    else judge.push(c);
  }
  for (let i = 0; i < judge.length; i += 40) {
    const chunk = judge.slice(i, i + 40);
    const input = chunk.map((c, n) => ({ id: String(n), text: c.text.slice(0, 1000) }));
    try {
      const r = await env.AI.run(MODEL, {
        messages: [
          { role: "system", content: PROMPT },
          { role: "user", content: JSON.stringify(input) },
        ],
        max_tokens: 3000,
        temperature: 0,
      });
      const out = r?.response ?? r?.choices?.[0]?.message?.content ?? r;
      const parsed = typeof out === "string" ? JSON.parse(out.slice(out.indexOf("{"), out.lastIndexOf("}") + 1)) : out;
      for (const e of parsed.results || []) {
        const c = chunk[Number(e.id)];
        const a = String(e.action || "").toUpperCase();
        if (c && (a === "KEEP" || a === "HIDE")) verdicts.set(c.id, a);
      }
    } catch (e) {
      // Leave this chunk unjudged; it gets retried on the next run.
      console.log("classify failed", e?.message);
    }
  }
  return verdicts;
}

// ---------- YouTube ----------

async function googleToken(b, cfg, tok) {
  const r = await b.fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    body: new URLSearchParams({
      client_id: cfg.client_id,
      client_secret: cfg.client_secret,
      refresh_token: tok.refresh_token,
      grant_type: "refresh_token",
    }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new AuthProblem("Google login stopped working: " + (j.error_description || j.error || r.status));
  return j.access_token;
}

async function runYouTube(env, b, dry) {
  const cfg = await getJ(env, "cfg:google");
  const tok = await getJ(env, "tok:google");
  if (!cfg || !tok) return { skipped: "not connected" };
  const H = { authorization: "Bearer " + (await googleToken(b, cfg, tok)) };
  const yt = async (path, params) => {
    const r = await b.fetch(YT + path + "?" + qs(params), { headers: H });
    const j = await r.json().catch(() => ({}));
    if (r.status === 401 || r.status === 403) throw new AuthProblem("YouTube refused access: " + (j.error?.message || r.status));
    if (!r.ok) throw new Error(`YouTube ${path} ${r.status} ${j.error?.message || ""}`);
    return j;
  };

  const seen = await loadSeen(env, "youtube");
  const state = (await getJ(env, "state:youtube")) || {};
  const found = new Map();
  const rc = {};
  const needReplies = [];

  const take = (c) => {
    const s = c.snippet || {};
    if (seen[c.id] || found.has(c.id)) return;
    if (s.authorChannelId?.value === tok.channel_id) {
      seen[c.id] = today();
      return;
    }
    if (s.moderationStatus && s.moderationStatus !== "published") return;
    found.set(c.id, {
      id: c.id,
      text: s.textOriginal ?? s.textDisplay ?? "",
      who: s.authorDisplayName || "",
      where: s.videoId ? "https://youtu.be/" + s.videoId : "",
    });
  };

  const scan = async (pageToken, pages) => {
    let pt = pageToken;
    for (let i = 0; i < pages; i++) {
      if (b.left < 8) return pt; // leave room for replies and hiding
      const j = await yt("/commentThreads", {
        part: "snippet,replies",
        allThreadsRelatedToChannelId: tok.channel_id,
        maxResults: 100,
        order: "time",
        textFormat: "plainText",
        pageToken: pt,
      });
      for (const th of j.items || []) {
        take(th.snippet.topLevelComment);
        const inline = th.replies?.comments || [];
        inline.forEach(take);
        const total = th.snippet.totalReplyCount || 0;
        rc[th.id] = total;
        if (total > inline.length && (state.rc?.[th.id] ?? -1) !== total) needReplies.push(th.id);
      }
      pt = j.nextPageToken;
      if (!pt) return null;
    }
    return pt;
  };

  // Newest 200 threads every run, plus 4 more pages of older ones until the backlog is done.
  const afterRecent = await scan(undefined, 2);
  if (state.backfill !== "done") {
    const start = state.backfill || afterRecent;
    state.backfill = start ? (await scan(start, 4)) || "done" : "done";
  }
  for (const id of needReplies) {
    if (b.left < 4) {
      rc[id] = state.rc?.[id] ?? -1; // try again next run
      continue;
    }
    const j = await yt("/comments", { part: "snippet", parentId: id, maxResults: 100, textFormat: "plainText" });
    (j.items || []).forEach(take);
  }

  const items = [...found.values()];
  const verdicts = await classify(env, items);
  const toHide = items.filter((c) => verdicts.get(c.id) === "HIDE");
  const hidden = [];
  const failed = [];
  if (!dry) {
    for (let i = 0; i < toHide.length; i += 50) {
      const chunk = toHide.slice(i, i + 50);
      if (b.left < 1) {
        failed.push(...chunk);
        continue;
      }
      const r = await b.fetch(
        YT + "/comments/setModerationStatus?" + qs({ id: chunk.map((c) => c.id).join(","), moderationStatus: "heldForReview" }),
        { method: "POST", headers: H },
      );
      if (r.ok) hidden.push(...chunk);
      else {
        failed.push(...chunk);
        console.log("YouTube hide failed", r.status, await r.text().catch(() => ""));
      }
    }
    const failedIds = new Set(failed.map((c) => c.id));
    for (const c of items) if (verdicts.has(c.id) && !failedIds.has(c.id)) seen[c.id] = today();
    state.rc = rc;
    await putJ(env, "seen:youtube", seen);
    await putJ(env, "state:youtube", state);
  }
  return report(items, verdicts, dry ? toHide : hidden, failed);
}

// ---------- Facebook + Instagram ----------

async function graph(b, path, params, token) {
  const r = await b.fetch(GRAPH + path + "?" + qs({ ...params, access_token: token }));
  const j = await r.json().catch(() => ({}));
  if (j.error) {
    const msg = `${j.error.message} (code ${j.error.code})`;
    if ([190, 102, 10, 200].includes(j.error.code) || r.status === 401) throw new AuthProblem("Meta refused access: " + msg);
    throw new Error("Meta " + path + ": " + msg);
  }
  return j;
}

async function runMeta(env, b, dry) {
  const tok = await getJ(env, "tok:meta");
  if (!tok) return { skipped: "not connected" };
  const seen = await loadSeen(env, "meta");
  const found = new Map();

  for (const pg of tok.pages || []) {
    const j = await graph(
      b,
      `/${pg.id}/feed`,
      {
        fields: "id,permalink_url,comments.filter(stream).order(reverse_chronological).limit(100){id,message,from,created_time,is_hidden}",
        limit: 25,
      },
      pg.token,
    );
    for (const post of j.data || []) {
      for (const c of post.comments?.data || []) {
        if (c.is_hidden || seen[c.id] || found.has(c.id)) continue;
        if (c.from?.id === pg.id) {
          seen[c.id] = today();
          continue;
        }
        found.set(c.id, { id: c.id, text: c.message || "", who: c.from?.name || "", where: post.permalink_url || "", kind: "fb", token: pg.token });
      }
    }
  }

  for (const ig of tok.igs || []) {
    const j = await graph(
      b,
      `/${ig.id}/media`,
      {
        fields: "id,permalink,comments.limit(50){id,text,username,timestamp,hidden,replies{id,text,username,timestamp,hidden}}",
        limit: 25,
      },
      ig.token,
    );
    for (const m of j.data || []) {
      for (const c of m.comments?.data || []) {
        for (const x of [c, ...(c.replies?.data || [])]) {
          if (x.hidden || seen[x.id] || found.has(x.id)) continue;
          if (x.username && x.username === ig.username) {
            seen[x.id] = today();
            continue;
          }
          found.set(x.id, { id: x.id, text: x.text || "", who: "@" + (x.username || ""), where: m.permalink || "", kind: "ig", token: ig.token });
        }
      }
    }
  }

  const items = [...found.values()];
  const verdicts = await classify(env, items);
  const toHide = items.filter((c) => verdicts.get(c.id) === "HIDE");
  const hidden = [];
  const failed = [];
  if (!dry) {
    const byToken = new Map();
    for (const c of toHide) byToken.set(c.token, [...(byToken.get(c.token) || []), c]);
    for (const [token, list] of byToken) {
      for (let i = 0; i < list.length; i += 50) {
        const chunk = list.slice(i, i + 50);
        if (b.left < 1) {
          failed.push(...chunk);
          continue;
        }
        const batch = chunk.map((c) => ({ method: "POST", relative_url: c.kind === "fb" ? `${c.id}?is_hidden=true` : `${c.id}?hide=true` }));
        const r = await b.fetch(GRAPH, { method: "POST", body: new URLSearchParams({ access_token: token, batch: JSON.stringify(batch) }) });
        const res = await r.json().catch(() => null);
        chunk.forEach((c, n) => {
          if (Array.isArray(res) && res[n]?.code === 200) hidden.push(c);
          else {
            failed.push(c);
            console.log("Meta hide failed", c.id, JSON.stringify(Array.isArray(res) ? res[n] : res));
          }
        });
      }
    }
    const failedIds = new Set(failed.map((c) => c.id));
    for (const c of items) if (verdicts.has(c.id) && !failedIds.has(c.id)) seen[c.id] = today();
    await putJ(env, "seen:meta", seen);
  }
  return report(items, verdicts, dry ? toHide : hidden, failed);
}

async function saveMetaPages(env, userToken) {
  const j = await graph(
    makeBudget(5),
    "/me/accounts",
    { fields: "id,name,access_token,instagram_business_account{id,username}", limit: 100 },
    userToken,
  );
  const pages = (j.data || []).map((p) => ({ id: p.id, name: p.name, token: p.access_token }));
  const igs = (j.data || [])
    .filter((p) => p.instagram_business_account)
    .map((p) => ({ id: p.instagram_business_account.id, username: p.instagram_business_account.username, token: p.access_token }));
  if (!pages.length) throw new Error("No Facebook Page came back. Make sure you picked your Page (and its linked Instagram) when Facebook asked.");
  await putJ(env, "tok:meta", { pages, igs, connected_at: new Date().toISOString() });
  return { pages, igs };
}

async function metaLongToken(cfg, shortToken) {
  const r = await fetch(
    GRAPH + "/oauth/access_token?" + qs({ grant_type: "fb_exchange_token", client_id: cfg.client_id, client_secret: cfg.client_secret, fb_exchange_token: shortToken }),
  );
  const j = await r.json();
  if (!r.ok || !j.access_token) throw new Error(j.error?.message || "Meta didn't return a long-lived token");
  return j.access_token;
}

// ---------- X ----------

async function runX(env, b, dry) {
  const cfg = await getJ(env, "cfg:x");
  const tok = await getJ(env, "tok:x");
  if (!cfg || !tok) return { skipped: "not connected" };

  const r = await b.fetch(XAPI + "/oauth2/token", {
    method: "POST",
    headers: { authorization: "Basic " + btoa(cfg.client_id + ":" + cfg.client_secret), "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: tok.refresh_token, client_id: cfg.client_id }),
  });
  const t = await r.json().catch(() => ({}));
  if (!r.ok) throw new AuthProblem("X login stopped working: " + (t.error_description || t.error || r.status));
  // X hands out a new refresh token every time and kills the old one, so save it right away.
  if (t.refresh_token) {
    tok.refresh_token = t.refresh_token;
    await putJ(env, "tok:x", tok);
  }
  const H = { authorization: "Bearer " + t.access_token };

  const state = (await getJ(env, "state:x")) || {};
  const seen = await loadSeen(env, "x");
  const found = new Map();
  let newest = null;
  let next = null;
  for (let i = 0; i < 3; i++) {
    const params = {
      query: `to:${tok.username} is:reply -from:${tok.username}`,
      max_results: 100,
      "tweet.fields": "created_at,author_id,conversation_id",
      expansions: "author_id",
      "user.fields": "username",
      since_id: state.since_id,
      next_token: next,
    };
    const rr = await b.fetch(XAPI + "/tweets/search/recent?" + qs(params), { headers: H });
    const j = await rr.json().catch(() => ({}));
    if ([401, 402, 403].includes(rr.status)) throw new AuthProblem(`X refused the search (${rr.status}): ${j.detail || j.title || ""}. If it mentions credits, the X developer account needs more credit.`);
    if (!rr.ok) throw new Error(`X search ${rr.status} ${j.detail || ""}`);
    if (i === 0 && j.meta?.newest_id) newest = j.meta.newest_id;
    const users = Object.fromEntries((j.includes?.users || []).map((u) => [u.id, u.username]));
    for (const p of j.data || []) {
      if (seen[p.id] || found.has(p.id)) continue;
      found.set(p.id, { id: p.id, text: p.text || "", who: "@" + (users[p.author_id] || p.author_id), where: "https://x.com/i/status/" + p.id });
    }
    next = j.meta?.next_token;
    if (!next) break;
  }

  const items = [...found.values()];
  const verdicts = await classify(env, items);
  const toHide = items.filter((c) => verdicts.get(c.id) === "HIDE");
  const hidden = [];
  const failed = [];
  if (!dry) {
    for (const c of toHide) {
      if (b.left < 1) {
        failed.push(c);
        continue;
      }
      const hr = await b.fetch(XAPI + `/tweets/${c.id}/hidden`, {
        method: "PUT",
        headers: { ...H, "content-type": "application/json" },
        body: JSON.stringify({ hidden: true }),
      });
      const hj = await hr.json().catch(() => ({}));
      if (hr.ok && hj.data?.hidden) hidden.push(c);
      // X only lets you hide replies in conversations you started. Anything else can't be hidden; don't retry it.
      else if (hr.status === 403) c.unhideable = true;
      else failed.push(c);
    }
    const failedIds = new Set(failed.map((c) => c.id));
    for (const c of items) if (verdicts.has(c.id) && !failedIds.has(c.id)) seen[c.id] = today();
    const allJudged = items.every((c) => verdicts.has(c.id));
    if (newest && !failed.length && allJudged && !next) state.since_id = newest;
    await putJ(env, "seen:x", seen);
    await putJ(env, "state:x", state);
  }
  return report(items, verdicts, dry ? toHide : hidden, failed);
}

// ---------- running ----------

function report(items, verdicts, hidden, failed) {
  const strip = (c) => ({ who: c.who, text: c.text.slice(0, 200), where: c.where });
  return {
    checked: items.length,
    unjudged: items.filter((c) => !verdicts.has(c.id)).length,
    hidden: hidden.map(strip),
    failed: failed.map(strip),
  };
}

const RUNNERS = { youtube: runYouTube, meta: runMeta, x: runX };
const LABEL = { youtube: "YouTube", meta: "Facebook/Instagram", x: "X" };

export async function runPlatform(env, p, dry = false) {
  const b = makeBudget(BUDGET);
  const prev = (await getJ(env, "status:" + p)) || {};
  let status;
  let result;
  try {
    result = await RUNNERS[p](env, b, dry);
    status = { at: new Date().toISOString(), ok: true, checked: result.checked ?? 0, hidden: result.hidden?.length ?? 0, skipped: result.skipped, fails: 0 };
  } catch (e) {
    result = { error: e.message };
    const fails = (prev.ok === false ? prev.fails || 1 : 0) + 1;
    status = { at: new Date().toISOString(), ok: false, error: e.message, fails };
    if (!dry && fails >= 2) await alertOwner(env, LABEL[p], e.message);
  }
  if (!dry) await putJ(env, "status:" + p, status);
  return result;
}

async function alertOwner(env, platform, msg) {
  const flag = "alerted:" + platform;
  if (await env.KV.get(flag)) return;
  const cfg = await getJ(env, "cfg:google");
  const tok = await getJ(env, "tok:google");
  if (!cfg || !tok?.email) return;
  try {
    const at = await googleToken(makeBudget(1), cfg, tok);
    const body =
      `The comment cleanup couldn't run on ${platform} two times in a row:\n\n${msg}\n\n` +
      `If it says a login expired or was revoked, reconnect it here:\n${env.ORIGIN}/setup?key=${env.SETUP_KEY}\n`;
    const raw = b64urlText(
      `To: ${tok.email}\r\nSubject: Comment cleanup: ${platform} needs attention\r\nContent-Type: text/plain; charset=UTF-8\r\n\r\n${body}`,
    );
    const r = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", {
      method: "POST",
      headers: { authorization: "Bearer " + at, "content-type": "application/json" },
      body: JSON.stringify({ raw }),
    });
    if (r.ok) await env.KV.put(flag, "1", { expirationTtl: 86400 });
  } catch (e) {
    console.log("alert failed", e?.message);
  }
}

// ---------- setup pages ----------

function page(title, body, status = 200) {
  return new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>${esc(title)}</title>
<style>
:root{--bg:#fafaf7;--fg:#1d1d1b;--muted:#6b6b66;--line:#e2e1da;--card:#fff;--accent:#1f4e79;--ok:#2e7d32;--bad:#b3261e}
@media (prefers-color-scheme:dark){:root{--bg:#141413;--fg:#ecebe6;--muted:#a3a29b;--line:#2f2e2b;--card:#1c1c1a;--accent:#8fb8e0;--ok:#81c784;--bad:#f28b82}}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.5 system-ui,-apple-system,sans-serif}
main{max-width:720px;margin:0 auto;padding:24px 16px 64px}
h1{font-size:1.5rem;margin:0 0 4px}h2{font-size:1.15rem;margin:0 0 8px}
p{margin:6px 0}.muted{color:var(--muted)}
section{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:16px;margin:16px 0}
label{display:block;font-size:.9rem;margin:10px 0 2px}
input[type=text],input[type=password]{width:100%;box-sizing:border-box;padding:8px;border:1px solid var(--line);border-radius:6px;background:var(--bg);color:var(--fg);font:inherit}
button,.btn{display:inline-block;margin-top:12px;padding:8px 14px;border-radius:6px;border:1px solid var(--accent);background:var(--accent);color:var(--bg);font:inherit;text-decoration:none;cursor:pointer}
.btn.ghost{background:transparent;color:var(--accent)}
code{background:var(--bg);border:1px solid var(--line);border-radius:4px;padding:1px 5px;word-break:break-all}
.ok{color:var(--ok)}.bad{color:var(--bad)}
</style></head><body><main>${body}</main></body></html>`,
    { status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-robots-tag": "noindex" } },
  );
}

function statusLine(s) {
  if (!s) return `<p class="muted">Hasn't run yet.</p>`;
  const when = new Date(s.at).toLocaleString("en-US", { timeZone: "America/New_York", dateStyle: "medium", timeStyle: "short" });
  if (s.skipped) return `<p class="muted">Last check ${esc(when)}: not connected yet.</p>`;
  if (s.ok) return `<p class="ok">Last check ${esc(when)}: looked at ${s.checked} new comment(s), hid ${s.hidden}.</p>`;
  return `<p class="bad">Last check ${esc(when)} failed: ${esc(s.error)}</p>`;
}

async function setupPage(env, origin, note = "") {
  const k = encodeURIComponent(env.SETUP_KEY);
  const [gc, gt, mc, mt, xc, xt, sy, sm, sx] = await Promise.all(
    ["cfg:google", "tok:google", "cfg:meta", "tok:meta", "cfg:x", "tok:x", "status:youtube", "status:meta", "status:x"].map((n) => getJ(env, n)),
  );
  const form = (p, cfg, extra = "") => `
<form method="post" action="/setup?key=${k}">
<input type="hidden" name="p" value="${p}">
<label>Client ID / App ID</label><input type="text" name="client_id" value="${esc(cfg?.client_id)}" autocomplete="off">
<label>Client secret / App secret ${cfg?.client_secret ? '<span class="muted">(saved, leave blank to keep)</span>' : ""}</label>
<input type="password" name="client_secret" autocomplete="off">${extra}
<button type="submit">Save</button>
</form>`;
  const connect = (p, cfg, tok, label) =>
    cfg ? `<a class="btn ${tok ? "ghost" : ""}" href="/connect/${p}?key=${k}">${tok ? "Reconnect" : "Connect"} ${label}</a>` : "";

  const ytState = gt ? `<p class="ok">Connected: ${esc(gt.channel_title)} (${esc(gt.email)})</p>` : `<p class="muted">Not connected.</p>`;
  const metaState = mt
    ? `<p class="ok">Connected: ${mt.pages.map((p) => esc(p.name)).join(", ")}${mt.igs.length ? " + Instagram " + mt.igs.map((i) => "@" + esc(i.username)).join(", ") : ' <span class="bad">(no Instagram linked to this Page)</span>'}</p>`
    : `<p class="muted">Not connected.</p>`;
  const xState = xt ? `<p class="ok">Connected: @${esc(xt.username)}</p>` : `<p class="muted">Not connected.</p>`;

  return page(
    "Comment cleanup",
    `<h1>Comment cleanup</h1>
<p class="muted">Checks every 3 hours and hides anything negative. Nothing is deleted.</p>
${note ? `<p class="bad">${esc(note)}</p>` : ""}

<section><h2>YouTube</h2>${ytState}${statusLine(sy)}
<p>Redirect URI to paste into Google Cloud: <code>${esc(origin)}/callback/google</code></p>
${form("google", gc)}${connect("google", gc, gt, "YouTube")}</section>

<section><h2>Facebook + Instagram</h2>${metaState}${statusLine(sm)}
<p>Redirect URI to paste into the Meta app: <code>${esc(origin)}/callback/meta</code></p>
${form("meta", mc, `<label>Configuration ID <span class="muted">(only if Meta's Login for Business asks for one)</span></label><input type="text" name="config_id" value="${esc(mc?.config_id)}" autocomplete="off">`)}
${connect("meta", mc, mt, "Facebook + Instagram")}
${mc ? `<form method="post" action="/setup?key=${k}"><input type="hidden" name="p" value="meta_token">
<label>Or paste a User access token from Graph API Explorer</label><input type="password" name="token" autocomplete="off"><button type="submit">Use this token</button></form>` : ""}
</section>

<section><h2>X</h2>${xState}${statusLine(sx)}
<p>Callback URI to paste into the X app: <code>${esc(origin)}/callback/x</code></p>
${form("x", xc)}${connect("x", xc, xt, "X")}</section>`,
  );
}

async function saveSetup(env, req, origin) {
  const f = await req.formData();
  const p = f.get("p");
  if (p === "meta_token") {
    const cfg = await getJ(env, "cfg:meta");
    try {
      const long = await metaLongToken(cfg, String(f.get("token") || "").trim());
      await saveMetaPages(env, long);
      return setupPage(env, origin, "");
    } catch (e) {
      return setupPage(env, origin, "That token didn't work: " + e.message);
    }
  }
  if (!["google", "meta", "x"].includes(p)) return setupPage(env, origin, "Unknown form.");
  const old = (await getJ(env, "cfg:" + p)) || {};
  const cfg = {
    client_id: String(f.get("client_id") || "").trim() || old.client_id,
    client_secret: String(f.get("client_secret") || "").trim() || old.client_secret,
  };
  if (p === "meta") cfg.config_id = String(f.get("config_id") || "").trim() || undefined;
  if (!cfg.client_id || !cfg.client_secret) return setupPage(env, origin, "Both the ID and the secret are needed.");
  await putJ(env, "cfg:" + p, cfg);
  return setupPage(env, origin);
}

async function startConnect(env, p, origin) {
  const cfg = await getJ(env, "cfg:" + p);
  if (!cfg) return page("Not set up", "<p>Save the ID and secret on the setup page first.</p>", 400);
  const state = rand(16);
  const redirect = `${origin}/callback/${p}`;
  const rec = { p };
  let url;
  if (p === "google") {
    url =
      "https://accounts.google.com/o/oauth2/v2/auth?" +
      qs({
        client_id: cfg.client_id,
        redirect_uri: redirect,
        response_type: "code",
        scope: "openid email https://www.googleapis.com/auth/youtube.force-ssl https://www.googleapis.com/auth/gmail.send",
        access_type: "offline",
        prompt: "consent",
        state,
      });
  } else if (p === "meta") {
    url =
      "https://www.facebook.com/v23.0/dialog/oauth?" +
      qs({ client_id: cfg.client_id, redirect_uri: redirect, state, response_type: "code", ...(cfg.config_id ? { config_id: cfg.config_id } : { scope: META_SCOPES }) });
  } else {
    rec.verifier = rand(32);
    url =
      "https://x.com/i/oauth2/authorize?" +
      qs({
        response_type: "code",
        client_id: cfg.client_id,
        redirect_uri: redirect,
        scope: "tweet.read users.read tweet.moderate.write offline.access",
        state,
        code_challenge: b64url(await sha256(rec.verifier)),
        code_challenge_method: "S256",
      });
  }
  await putJ(env, "oauth:" + state, rec, { expirationTtl: 900 });
  return Response.redirect(url, 302);
}

async function finishConnect(env, p, url) {
  const st = url.searchParams.get("state");
  const rec = st ? await getJ(env, "oauth:" + st) : null;
  if (!rec || rec.p !== p) return page("Link expired", "<p>Start again from the setup page.</p>", 400);
  await env.KV.delete("oauth:" + st);
  const back = `<p><a class="btn" href="/setup?key=${encodeURIComponent(env.SETUP_KEY)}">Back to setup</a></p>`;
  const code = url.searchParams.get("code");
  if (!code) return page("Not connected", `<p>Permission wasn't granted: ${esc(url.searchParams.get("error_description") || url.searchParams.get("error"))}</p>${back}`);
  const cfg = await getJ(env, "cfg:" + p);
  const redirect = `${url.origin}/callback/${p}`;
  try {
    let who;
    if (p === "google") {
      const r = await fetch("https://oauth2.googleapis.com/token", {
        method: "POST",
        body: new URLSearchParams({ code, client_id: cfg.client_id, client_secret: cfg.client_secret, redirect_uri: redirect, grant_type: "authorization_code" }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error_description || j.error);
      if (!j.refresh_token) throw new Error("Google didn't hand back a long-term login. Remove this app at myaccount.google.com/permissions, then connect again.");
      const claims = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(j.id_token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0))));
      const ch = await (await fetch(YT + "/channels?part=id,snippet&mine=true", { headers: { authorization: "Bearer " + j.access_token } })).json();
      const c = ch.items?.[0];
      if (!c) throw new Error("That Google account has no YouTube channel. Sign in with the account that owns the channel.");
      await putJ(env, "tok:google", { refresh_token: j.refresh_token, email: claims.email, channel_id: c.id, channel_title: c.snippet.title });
      who = `${c.snippet.title} (${claims.email})`;
    } else if (p === "meta") {
      const r = await fetch(GRAPH + "/oauth/access_token?" + qs({ client_id: cfg.client_id, client_secret: cfg.client_secret, redirect_uri: redirect, code }));
      const j = await r.json();
      if (!r.ok || !j.access_token) throw new Error(j.error?.message || "Meta didn't return a token");
      const { pages, igs } = await saveMetaPages(env, await metaLongToken(cfg, j.access_token));
      who = pages.map((x) => x.name).join(", ") + (igs.length ? " + Instagram " + igs.map((i) => "@" + i.username).join(", ") : " (no Instagram linked)");
    } else {
      const r = await fetch(XAPI + "/oauth2/token", {
        method: "POST",
        headers: { authorization: "Basic " + btoa(cfg.client_id + ":" + cfg.client_secret), "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ code, grant_type: "authorization_code", redirect_uri: redirect, code_verifier: rec.verifier, client_id: cfg.client_id }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error_description || j.error || r.status);
      const me = await (await fetch(XAPI + "/users/me", { headers: { authorization: "Bearer " + j.access_token } })).json();
      if (!me.data) throw new Error(me.detail || "Couldn't read the X account");
      await putJ(env, "tok:x", { refresh_token: j.refresh_token, user_id: me.data.id, username: me.data.username });
      who = "@" + me.data.username;
    }
    return page("Connected", `<h1>Connected</h1><p>${esc(who)}</p>${back}`);
  } catch (e) {
    return page("Didn't work", `<h1>That didn't work</h1><p>${esc(e.message)}</p>${back}`, 400);
  }
}

// ---------- entry points ----------

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const origin = env.ORIGIN || url.origin;
    const parts = url.pathname.split("/").filter(Boolean);
    const p = parts[1];

    if (parts[0] === "callback" && ["google", "meta", "x"].includes(p)) return finishConnect(env, p, url);
    if (!keyOk(env, url.searchParams.get("key"))) return new Response("Not found", { status: 404 });

    if (parts[0] === "setup") return req.method === "POST" ? saveSetup(env, req, origin) : setupPage(env, origin);
    if (parts[0] === "connect" && ["google", "meta", "x"].includes(p)) return startConnect(env, p, origin);
    if (parts[0] === "run" && RUNNERS[url.searchParams.get("p")]) {
      const dry = url.searchParams.get("dry") !== "0";
      return Response.json(await runPlatform(env, url.searchParams.get("p"), dry));
    }
    if (parts[0] === "classify" && req.method === "POST") {
      const { texts = [] } = await req.json();
      const items = texts.map((t, i) => ({ id: "t" + i, text: t }));
      const v = await classify(env, items);
      return Response.json(items.map((c) => ({ text: c.text, action: v.get(c.id) || null })));
    }
    return new Response("Not found", { status: 404 });
  },

  async scheduled(event, env, ctx) {
    const p = CRONS[event.cron];
    if (p) ctx.waitUntil(runPlatform(env, p, false));
  },
};
