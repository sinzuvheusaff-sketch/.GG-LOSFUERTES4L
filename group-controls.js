"use strict";

/*
 * GROUP CONTROLS: gcname lock + nickname features
 * -----------------------------------------------
 * Commands (only the bot account and GC_ADMIN_IDS can use them):
 *
 *   !gcname lock [name]    lock the GC name (uses current name if none given)
 *   !gcname unlock
 *   !gcname set <name>     change the GC name once (does not lock)
 *   !gcname cycle start [sec] / stop / add / remove / list / clear
 *   !gcname status
 *
 *   !nick set <nickname>   @mention people or reply to their message
 *   !nick me <nickname>    nickname for the bot account
 *   !nick all <nickname>   everyone in the GC ({i} = 1,2,3... counter)
 *   !nick clear            clear nickname of @mentioned / replied person
 *   !nick clearall         clear everyone's nickname
 *   !nick lock             snapshot current nicknames and revert any change
 *   !nick unlock
 *   !nick list
 *   !nick status
 *
 * Env:
 *   GC_ADMIN_IDS=1000xxxx,1000yyyy   extra Facebook IDs allowed to use commands
 *   GROUP_LOCKS_FILE=/path/group-locks.json   where locks are saved
 */

const fs = require("fs");
const path = require("path");

const ADMIN_IDS = new Set(
  String(process.env.GC_ADMIN_IDS || "").split(",").map(s => s.trim()).filter(Boolean)
);

function locksFilePath() {
  if (process.env.GROUP_LOCKS_FILE) return process.env.GROUP_LOCKS_FILE;
  if (process.env.CELESTIAL_SESSION_FILE) {
    return path.join(path.dirname(process.env.CELESTIAL_SESSION_FILE), "group-locks.json");
  }
  return path.join(process.cwd(), "group-locks.json");
}

const FILE = locksFilePath();
// threadID -> { name: string|null, nicks: { userID: nickname }|null }
let locks = {};
try {
  if (fs.existsSync(FILE)) locks = JSON.parse(fs.readFileSync(FILE, "utf8")) || {};
} catch (e) {
  console.error("[GROUP] could not read locks file:", e.message);
  locks = {};
}

function saveLocks() {
  try {
    fs.writeFileSync(FILE, JSON.stringify(locks, null, 2));
  } catch (e) {
    console.error("[GROUP] could not save locks file:", e.message);
  }
}

function entry(threadID) {
  const key = String(threadID);
  if (!locks[key]) locks[key] = { name: null, nicks: null };
  return locks[key];
}

function cleanup(threadID) {
  const key = String(threadID);
  const e = locks[key];
  if (e && !e.name && !e.nicks) delete locks[key];
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
const jitter = (min, max) => min + Math.floor(Math.random() * (max - min));

// Works with both callback-style and promise-style fca methods.
function call(fn, ...args) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const done = (err, res) => {
      if (settled) return;
      settled = true;
      err ? reject(err) : resolve(res);
    };
    try {
      const r = fn(...args, done);
      if (r && typeof r.then === "function") r.then(v => done(null, v)).catch(done);
    } catch (e) {
      done(e);
    }
  });
}

// One queue per thread so name/nickname changes never overlap and stay paced.
const queues = new Map();
function enqueue(threadID, job) {
  const key = String(threadID);
  const cur = queues.get(key) || Promise.resolve();
  const next = cur.catch(() => {}).then(job).finally(() => {
    if (queues.get(key) === next) queues.delete(key);
  });
  queues.set(key, next);
  return next;
}

// Revert limiter: stops infinite fights if someone keeps changing it.
const revertLog = new Map();
const MAX_REVERTS_PER_MIN = Math.max(2, Number(process.env.GC_MAX_REVERTS_PER_MIN || 8));
function canRevert(threadID) {
  const key = String(threadID);
  const now = Date.now();
  const list = (revertLog.get(key) || []).filter(t => now - t < 60000);
  if (list.length >= MAX_REVERTS_PER_MIN) {
    revertLog.set(key, list);
    return false;
  }
  list.push(now);
  revertLog.set(key, list);
  return true;
}

async function reply(api, threadID, text, replyTo) {
  try {
    await call(
      (...a) => (replyTo ? api.sendMessage(a[0], a[1], a[2], replyTo) : api.sendMessage(a[0], a[1], a[2])),
      text,
      String(threadID)
    );
  } catch (e) {
    console.error("[GROUP] reply failed:", e?.message || e);
  }
}

async function getInfo(api, threadID) {
  return call(api.getThreadInfo.bind(api), String(threadID));
}

function isAdmin(senderID, botID) {
  const id = String(senderID || "");
  return id && (id === String(botID || "") || ADMIN_IDS.has(id));
}

function targetsFromEvent(event) {
  const ids = new Set();
  if (event.mentions && typeof event.mentions === "object") {
    for (const id of Object.keys(event.mentions)) ids.add(String(id));
  }
  if (!ids.size && event.messageReply?.senderID) ids.add(String(event.messageReply.senderID));
  return [...ids];
}

function stripMentions(body, event) {
  let text = String(body || "");
  if (event.mentions && typeof event.mentions === "object") {
    for (const tag of Object.values(event.mentions)) {
      if (tag) text = text.split(String(tag)).join(" ");
    }
  }
  return text.replace(/\s+/g, " ").trim();
}

async function setNick(api, threadID, userID, nickname) {
  await call(api.changeNickname.bind(api), nickname, String(threadID), String(userID));
}


// ------------------------------------------------------- gcname cycle (rotating names)

const PHRASES_FILE = path.join(path.dirname(FILE), "gcname-phrases.json");
const DEFAULT_PHRASES = [
  "U R NOTHING BUT ASH", "I BURIED U", "U R A STAIN", "I DISMANTLED U",
  "U R A FOOTNOTE", "U R FOOD FOR QENDO", "QENDO COOKED U", "QENDO IS IN UR HEAD"
];
const TAGS = [1, 420, 666, 777, 888, 999];
let phrases = null;
try { phrases = JSON.parse(fs.readFileSync(PHRASES_FILE, "utf8")); } catch (_) { phrases = null; }
if (!Array.isArray(phrases) || !phrases.length) phrases = DEFAULT_PHRASES.slice();
function savePhrases() {
  try { fs.writeFileSync(PHRASES_FILE, JSON.stringify(phrases, null, 2)); } catch (_) {}
}

const MIN_CYCLE_SEC = Math.max(6, Number(process.env.GC_MIN_CYCLE_SEC || 8));
const cycles = new Map(); // threadID -> { timer, last }

function stopCycle(threadID) {
  const c = cycles.get(String(threadID));
  if (!c) return false;
  clearTimeout(c.timer);
  cycles.delete(String(threadID));
  return true;
}

function startCycle(api, threadID, seconds) {
  stopCycle(threadID);
  const key = String(threadID);
  const state = { timer: null, last: "", fails: 0 };
  cycles.set(key, state);
  const tick = () => {
    if (cycles.get(key) !== state) return;
    let name;
    do {
      name = `${phrases[Math.floor(Math.random() * phrases.length)]} #${TAGS[Math.floor(Math.random() * TAGS.length)]}`;
    } while (name === state.last && phrases.length > 1);
    state.last = name;
    enqueue(key, async () => {
      try { await call(api.setTitle.bind(api), name, key); state.fails = 0; }
      catch (e) {
        console.error("[GROUP] cycle setTitle failed:", e?.message || e);
        if (++state.fails >= 3) { stopCycle(key); console.error("[GROUP] cycle stopped after 3 fails"); }
      }
    });
    state.timer = setTimeout(tick, seconds * 1000 + jitter(0, 2500));
  };
  state.timer = setTimeout(tick, 500);
}

async function handleCycle(api, event, args) {
  const threadID = String(event.threadID);
  const say = text => reply(api, threadID, text, event.messageID);
  const act = (args[0] || "status").toLowerCase();
  const rest = args.slice(1).join(" ").trim();

  if (act === "start") {
    const sec = Math.max(MIN_CYCLE_SEC, Number(args[1]) || 10);
    startCycle(api, threadID, sec);
    return say(`gcname cycle ON (every ~${sec}s) 🔁`);
  }
  if (act === "stop") return say(stopCycle(threadID) ? "gcname cycle OFF" : "di naman naka-on");
  if (act === "add") {
    if (!rest) return say("gamit: !gcname cycle add <phrase>");
    phrases.push(rest.toUpperCase()); savePhrases();
    return say(`added (#${phrases.length})`);
  }
  if (act === "remove") {
    const n = Number(args[1]);
    if (!n || n < 1 || n > phrases.length) return say("gamit: !gcname cycle remove <number>");
    phrases.splice(n - 1, 1);
    if (!phrases.length) phrases = DEFAULT_PHRASES.slice();
    savePhrases();
    return say("removed");
  }
  if (act === "clear") { phrases = DEFAULT_PHRASES.slice(); savePhrases(); return say("phrases reset to default"); }
  if (act === "list") return say(phrases.map((p, i) => `${i + 1}. ${p}`).join("\n"));
  return say(`gcname cycle: ${cycles.has(threadID) ? "ON" : "OFF"} · ${phrases.length} phrases\n!gcname cycle start [sec] · stop · add · remove <n> · list · clear`);
}

// ---------------------------------------------------------------- commands

async function handleGcname(api, event, args, botID) {
  const threadID = String(event.threadID);
  const sub = (args[0] || "status").toLowerCase();
  const rest = args.slice(1).join(" ").trim();
  const say = text => reply(api, threadID, text, event.messageID);

  if (sub === "cycle") return handleCycle(api, event, args.slice(1));

  if (sub === "lock") {
    let name = rest;
    if (!name) {
      try {
        name = String((await getInfo(api, threadID))?.threadName || "").trim();
      } catch (e) {
        return say("di ko makuha current gc name, lagay ka ng name: !gcname lock <name>");
      }
    }
    if (!name) return say("walang gc name ngayon, lagay ka: !gcname lock <name>");
    entry(threadID).name = name;
    saveLocks();
    if (rest) {
      await enqueue(threadID, async () => {
        try { await call(api.setTitle.bind(api), name, threadID); }
        catch (e) { console.error("[GROUP] setTitle failed:", e?.message || e); }
      });
    }
    return say(`gcname locked 🔒 "${name}"`);
  }

  if (sub === "unlock") {
    const e = locks[threadID];
    if (!e || !e.name) return say("walang gcname lock dito");
    e.name = null;
    cleanup(threadID);
    saveLocks();
    return say("gcname unlocked 🔓");
  }

  if (sub === "set") {
    if (!rest) return say("gamit: !gcname set <name>");
    return enqueue(threadID, async () => {
      try {
        await call(api.setTitle.bind(api), rest, threadID);
        const e = locks[threadID];
        if (e && e.name) { e.name = rest; saveLocks(); } // keep lock in sync with bot's own change
      } catch (e) {
        await say("di ma-change yung gc name (baka walang permission)");
      }
    });
  }

  if (sub === "status") {
    const e = locks[threadID];
    return say(e && e.name ? `gcname: LOCKED 🔒 "${e.name}"` : "gcname: not locked");
  }

  return say("!gcname lock [name] · unlock · set <name> · status");
}

async function handleNick(api, event, body, args, botID) {
  const threadID = String(event.threadID);
  const sub = (args[0] || "status").toLowerCase();
  const say = text => reply(api, threadID, text, event.messageID);
  const afterSub = () => {
    const text = stripMentions(body, event);
    const parts = text.split(/\s+/);
    return parts.slice(2).join(" ").trim(); // drop "!nick" and the subcommand
  };

  if (sub === "set") {
    const nickname = afterSub();
    const targets = targetsFromEvent(event);
    if (!targets.length) return say("mention mo yung tao o i-reply mo mensahe niya: !nick set <nickname>");
    if (!nickname) return say("lagay ka ng nickname: !nick set <nickname>");
    return enqueue(threadID, async () => {
      let ok = 0;
      for (const id of targets) {
        try {
          await setNick(api, threadID, id, nickname);
          const e = locks[threadID];
          if (e && e.nicks) e.nicks[id] = nickname;
          ok++;
        } catch (err) {
          console.error("[GROUP] changeNickname failed:", err?.message || err);
        }
        await sleep(jitter(1200, 2400));
      }
      saveLocks();
      await say(ok ? `nickname set (${ok}) ✅` : "di ma-set yung nickname");
    });
  }

  if (sub === "me") {
    const nickname = afterSub();
    if (!nickname) return say("gamit: !nick me <nickname>");
    return enqueue(threadID, async () => {
      try {
        await setNick(api, threadID, botID, nickname);
        const e = locks[threadID];
        if (e && e.nicks) { e.nicks[String(botID)] = nickname; saveLocks(); }
        await say("nickname set ✅");
      } catch (err) {
        await say("di ma-set yung nickname");
      }
    });
  }

  if (sub === "all") {
    const template = afterSub();
    if (!template) return say("gamit: !nick all <nickname> (pwede {i} para may bilang)");
    let info;
    try { info = await getInfo(api, threadID); }
    catch (e) { return say("di ko makuha member list"); }
    const ids = (info?.participantIDs || []).map(String);
    if (!ids.length) return say("walang members na nakuha");
    return enqueue(threadID, async () => {
      let ok = 0;
      for (let i = 0; i < ids.length; i++) {
        const nickname = template.replace(/\{i\}/g, String(i + 1));
        try {
          await setNick(api, threadID, ids[i], nickname);
          const e = locks[threadID];
          if (e && e.nicks) e.nicks[ids[i]] = nickname;
          ok++;
        } catch (err) {
          console.error("[GROUP] changeNickname failed:", err?.message || err);
        }
        await sleep(jitter(1500, 3000));
      }
      saveLocks();
      await say(`nickname all done (${ok}/${ids.length}) ✅`);
    });
  }

  if (sub === "clear") {
    const targets = targetsFromEvent(event);
    if (!targets.length) return say("mention o reply ka muna: !nick clear");
    return enqueue(threadID, async () => {
      let ok = 0;
      for (const id of targets) {
        try {
          await setNick(api, threadID, id, "");
          const e = locks[threadID];
          if (e && e.nicks) e.nicks[id] = "";
          ok++;
        } catch (err) {
          console.error("[GROUP] clear nickname failed:", err?.message || err);
        }
        await sleep(jitter(1200, 2400));
      }
      saveLocks();
      await say(ok ? `nickname cleared (${ok}) ✅` : "di ma-clear");
    });
  }

  if (sub === "clearall") {
    let info;
    try { info = await getInfo(api, threadID); }
    catch (e) { return say("di ko makuha member list"); }
    const ids = (info?.participantIDs || []).map(String);
    return enqueue(threadID, async () => {
      let ok = 0;
      for (const id of ids) {
        try {
          await setNick(api, threadID, id, "");
          const e = locks[threadID];
          if (e && e.nicks) e.nicks[id] = "";
          ok++;
        } catch (err) {
          console.error("[GROUP] clear nickname failed:", err?.message || err);
        }
        await sleep(jitter(1500, 3000));
      }
      saveLocks();
      await say(`cleared all (${ok}/${ids.length}) ✅`);
    });
  }

  if (sub === "lock") {
    let info;
    try { info = await getInfo(api, threadID); }
    catch (e) { return say("di ko makuha current nicknames"); }
    const nicks = {};
    for (const [id, nick] of Object.entries(info?.nicknames || {})) {
      if (nick) nicks[String(id)] = String(nick);
    }
    entry(threadID).nicks = nicks;
    saveLocks();
    return say(`nickname lock 🔒 (${Object.keys(nicks).length} saved)`);
  }

  if (sub === "unlock") {
    const e = locks[threadID];
    if (!e || !e.nicks) return say("walang nickname lock dito");
    e.nicks = null;
    cleanup(threadID);
    saveLocks();
    return say("nickname unlocked 🔓");
  }

  if (sub === "list") {
    try {
      const info = await getInfo(api, threadID);
      const rows = Object.entries(info?.nicknames || {}).filter(([, n]) => n);
      if (!rows.length) return say("walang nickname sa gc na to");
      return say(rows.map(([id, n]) => `${id}: ${n}`).join("\n"));
    } catch (e) {
      return say("di ko makuha list");
    }
  }

  if (sub === "status") {
    const e = locks[threadID];
    return say(e && e.nicks ? `nicknames: LOCKED 🔒 (${Object.keys(e.nicks).length})` : "nicknames: not locked");
  }

  return say("!nick set · me · all · clear · clearall · lock · unlock · list · status");
}

// ------------------------------------------------------------ lock watchers

function onThreadEvent(api, event, botID) {
  const threadID = String(event.threadID || "");
  const e = locks[threadID];
  if (!e) return;
  const author = String(event.author || "");
  if (author && author === String(botID || "")) return; // our own change, ignore

  if (event.logMessageType === "log:thread-name" && e.name) {
    const newName = String(event.logMessageData?.name ?? "");
    if (newName === e.name) return;
    if (!canRevert(threadID)) return;
    enqueue(threadID, async () => {
      await sleep(jitter(1500, 3500));
      try { await call(api.setTitle.bind(api), e.name, threadID); }
      catch (err) { console.error("[GROUP] gcname revert failed:", err?.message || err); }
    });
    return;
  }

  if (event.logMessageType === "log:user-nickname" && e.nicks) {
    const uid = String(event.logMessageData?.participant_id || "");
    if (!uid) return;
    const locked = e.nicks[uid] ?? "";
    const now = String(event.logMessageData?.nickname ?? "");
    if (now === locked) return;
    if (!canRevert(threadID)) return;
    enqueue(threadID, async () => {
      await sleep(jitter(1500, 3500));
      try { await setNick(api, threadID, uid, locked); }
      catch (err) { console.error("[GROUP] nickname revert failed:", err?.message || err); }
    });
  }
}

/**
 * Call this for EVERY raw event from listenMqtt.
 * Returns true if the event was a group-control command (so the caller can stop).
 */
function handleEvent(api, event, botID) {
  if (!event) return false;

  if (event.type === "event") {
    try { onThreadEvent(api, event, botID); } catch (e) { console.error("[GROUP]", e); }
    return false;
  }

  if (event.type && event.type !== "message" && event.type !== "message_reply") return false;
  const body = String(event.body || "").trim();
  const match = /^!(gcname|nick)(?:\s|$)/i.exec(body);
  if (!match) return false;

  if (!isAdmin(event.senderID, botID)) return true; // swallow silently for non-admins

  const args = body.split(/\s+/).slice(1);
  const run = match[1].toLowerCase() === "gcname"
    ? handleGcname(api, event, args, botID)
    : handleNick(api, event, body, args, botID);
  Promise.resolve(run).catch(err => console.error("[GROUP] command error:", err));
  return true;
}


// ------------------------------------------------------------ dashboard API
// Used by dashboard-api.js. Every action works on an explicit threadID, no chat message needed.

async function listGroups(api) {
  if (!api || typeof api.getThreadList !== "function") throw new Error("Bot is not connected");
  const list = await call(api.getThreadList.bind(api), 100, null, ["INBOX"]);
  return (list || [])
    .filter(t => t && (t.isGroup === undefined || t.isGroup))
    .map(t => ({
      threadID: String(t.threadID),
      name: t.name || t.threadName || "(no name)",
      members: Array.isArray(t.participants) ? t.participants.length : (t.participantIDs || []).length || null
    }));
}

function threadState(threadID) {
  const key = String(threadID);
  const e = locks[key] || {};
  return {
    threadID: key,
    gcname_locked: Boolean(e.name),
    gcname_lock: e.name || null,
    nick_locked: Boolean(e.nicks),
    nick_lock_count: e.nicks ? Object.keys(e.nicks).length : 0,
    cycle_on: cycles.has(key),
    phrases
  };
}

async function members(api, threadID) {
  const info = await getInfo(api, threadID);
  const ids = (info?.participantIDs || []).map(String);
  const nicks = info?.nicknames || {};
  let names = {};
  try {
    const u = await call(api.getUserInfo.bind(api), ids);
    for (const id of ids) names[id] = u?.[id]?.name || "";
  } catch (_) {}
  return {
    threadName: info?.threadName || "",
    members: ids.map(id => ({ id, name: names[id] || "", nickname: nicks[id] || "" }))
  };
}

const jobs = new Map(); // "feature:threadID" -> { cancelled }

function startJob(feature, threadID) {
  const key = feature + ":" + String(threadID);
  if (jobs.has(key)) throw new Error("Already running in this group, press Stop first");
  const token = { cancelled: false };
  jobs.set(key, token);
  return { token, done: () => { if (jobs.get(key) === token) jobs.delete(key); } };
}

function cancelJob(feature, threadID) {
  const t = jobs.get(feature + ":" + String(threadID));
  if (t) t.cancelled = true;
  return Boolean(t);
}

async function runNickJob(api, threadID, ids, makeNick, pause = [1500, 3000], token = { cancelled: false }) {
  let ok = 0;
  for (let i = 0; i < ids.length; i++) {
    if (token.cancelled) break;
    try {
      const n = makeNick(i);
      await setNick(api, threadID, ids[i], n);
      const e = locks[String(threadID)];
      if (e && e.nicks) e.nicks[ids[i]] = n;
      ok++;
    } catch (err) {
      console.error("[GROUP] nickname job failed:", err?.message || err);
    }
    await sleep(jitter(pause[0], pause[1]));
  }
  saveLocks();
  console.log("[GROUP] nickname job " + (token.cancelled ? "stopped " : "done ") + ok + "/" + ids.length);
}

// ----- count 1-60 + WIN "resibo"
const REASONS_FILE = path.join(path.dirname(FILE), "gcname-reasons.json");
const DEFAULT_REASONS = [
  "walang sagot sa loob ng 60 segundo",
  "nag-seen lang, walang lakas sumagot",
  "tahimik na parang offline",
  "nag-AFK pagdating ng resibo",
  "natulog sa gitna ng laban",
  "nawalan ng sasabihin habang nagbibilang",
  "nagtago sa likod ng chat off"
];
let reasons = null;
try { reasons = JSON.parse(fs.readFileSync(REASONS_FILE, "utf8")); } catch (_) { reasons = null; }
if (!Array.isArray(reasons) || !reasons.length) reasons = DEFAULT_REASONS.slice();
function saveReasons() {
  try { fs.writeFileSync(REASONS_FILE, JSON.stringify(reasons, null, 2)); } catch (_) {}
}

const MIN_COUNT_SEC = Math.max(1, Number(process.env.GC_MIN_COUNT_SEC || 1.2));

function sendText(api, threadID, text) {
  return call((a, b, c) => api.sendMessage(a, b, c), text, String(threadID));
}

async function runCount(api, threadID, opts, job) {
  const { token, done } = job;
  try {
    let fails = 0;
    for (let n = 1; n <= 60; n++) {
      if (token.cancelled) return;
      try { await sendText(api, threadID, String(n)); fails = 0; }
      catch (e) {
        console.error("[GROUP] count send failed:", e?.message || e);
        if (++fails >= 3) { console.error("[GROUP] count aborted after 3 fails"); return; }
        n--; // retry same number
      }
      await sleep(opts.seconds * 1000 + jitter(0, 500));
    }
    if (token.cancelled) return;
    const reason = (opts.reason || reasons[Math.floor(Math.random() * reasons.length)])
      .replace(/\{winner\}/gi, opts.winner).replace(/\{loser\}/gi, opts.loser);
    await sendText(api, threadID, opts.winner + " WIN\n" + opts.loser + " LOSE\n\n" + reason);
  } finally {
    done();
  }
}

async function dashboardAction(api, botID, action, p = {}) {
  if (action === "active") {
    const f = String(p.feature || "");
    let threads = [];
    if (f === "lock") threads = Object.keys(locks).filter(k => locks[k] && locks[k].name);
    else if (f === "cycle") threads = [...cycles.keys()];
    else if (f === "nick" || f === "count") {
      threads = [...jobs.keys()].filter(k => k.startsWith(f + ":")).map(k => k.slice(f.length + 1));
    }
    return { threads };
  }
  if (action === "reasons-get") return { reasons };
  if (action === "reasons-set") {
    const list = (Array.isArray(p.reasons) ? p.reasons : String(p.reasons || "").split("\n"))
      .map(x => String(x).trim().slice(0, 200)).filter(Boolean).slice(0, 100);
    reasons = list.length ? list : DEFAULT_REASONS.slice();
    saveReasons();
    return { reasons };
  }

  if (!api) throw new Error("Bot is not connected");
  const threadID = String(p.threadID || "").trim();
  if (!/^\d{5,}$/.test(threadID)) throw new Error("Pick a group first");

  switch (action) {
    case "state":
      return threadState(threadID);

    case "members":
      return Object.assign({ threadID }, await members(api, threadID));

    case "gcname-lock": {
      let name = String(p.name || "").trim();
      const changeIt = Boolean(name);
      if (!name) name = String((await getInfo(api, threadID))?.threadName || "").trim();
      if (!name) throw new Error("Group has no name, type one");
      entry(threadID).name = name;
      saveLocks();
      if (changeIt) enqueue(threadID, () => call(api.setTitle.bind(api), name, threadID).catch(e => console.error("[GROUP]", e?.message || e)));
      return threadState(threadID);
    }
    case "gcname-unlock": {
      const e = locks[threadID];
      if (e) { e.name = null; cleanup(threadID); saveLocks(); }
      return threadState(threadID);
    }
    case "gcname-set": {
      const name = String(p.name || "").trim();
      if (!name) throw new Error("Type a name");
      await enqueue(threadID, () => call(api.setTitle.bind(api), name, threadID));
      const e = locks[threadID];
      if (e && e.name) { e.name = name; saveLocks(); }
      return threadState(threadID);
    }

    case "nick-set": {
      const nickname = String(p.nickname || "").trim();
      const ids = (Array.isArray(p.userIDs) ? p.userIDs : [p.userID]).map(String).filter(Boolean);
      if (!ids.length) throw new Error("Pick a member");
      if (!nickname) throw new Error("Type a nickname");
      enqueue(threadID, () => runNickJob(api, threadID, ids, () => nickname, [1200, 2400]));
      return { queued: ids.length };
    }
    case "nick-all": {
      const template = String(p.nickname || "").trim();
      if (!template) throw new Error("Type a nickname ({i} = counter)");
      const ids = (await getInfo(api, threadID))?.participantIDs?.map(String) || [];
      const job = startJob("nick", threadID);
      enqueue(threadID, () => runNickJob(api, threadID, ids, i => template.replace(/\{i\}/g, String(i + 1)), [1500, 3000], job.token).finally(job.done));
      return { queued: ids.length };
    }
    case "nick-clear": {
      const ids = (Array.isArray(p.userIDs) ? p.userIDs : [p.userID]).map(String).filter(Boolean);
      if (!ids.length) throw new Error("Pick a member");
      enqueue(threadID, () => runNickJob(api, threadID, ids, () => "", [1200, 2400]));
      return { queued: ids.length };
    }
    case "nick-clearall": {
      const ids = (await getInfo(api, threadID))?.participantIDs?.map(String) || [];
      const job = startJob("nick", threadID);
      enqueue(threadID, () => runNickJob(api, threadID, ids, () => "", [1500, 3000], job.token).finally(job.done));
      return { queued: ids.length };
    }
    case "nick-lock": {
      const info = await getInfo(api, threadID);
      const nicks = {};
      for (const [id, n] of Object.entries(info?.nicknames || {})) if (n) nicks[String(id)] = String(n);
      entry(threadID).nicks = nicks;
      saveLocks();
      return threadState(threadID);
    }
    case "nick-unlock": {
      const e = locks[threadID];
      if (e) { e.nicks = null; cleanup(threadID); saveLocks(); }
      return threadState(threadID);
    }

    case "cycle-start": {
      const sec = Math.max(MIN_CYCLE_SEC, Number(p.seconds) || 10);
      startCycle(api, threadID, sec);
      return threadState(threadID);
    }
    case "cycle-stop":
      stopCycle(threadID);
      return threadState(threadID);
    case "phrase-add": {
      const t = String(p.phrase || "").trim();
      if (!t) throw new Error("Type a phrase");
      phrases.push(t.toUpperCase().slice(0, 80)); savePhrases();
      return threadState(threadID);
    }
    case "phrase-remove": {
      const n = Number(p.index);
      if (!(n >= 0 && n < phrases.length)) throw new Error("Bad phrase number");
      phrases.splice(n, 1);
      if (!phrases.length) phrases = DEFAULT_PHRASES.slice();
      savePhrases();
      return threadState(threadID);
    }
    case "phrase-reset":
      phrases = DEFAULT_PHRASES.slice(); savePhrases();
      return threadState(threadID);

    case "feature-start": {
      const f = String(p.feature || "");
      const text = String(p.text || "").trim();
      if (f === "lock") return dashboardAction(api, botID, "gcname-lock", { threadID, name: text });
      if (f === "nick") return dashboardAction(api, botID, "nick-all", { threadID, nickname: text });
      if (f === "cycle") return dashboardAction(api, botID, "cycle-start", { threadID, seconds: p.seconds });
      if (f === "count") {
        const job = startJob("count", threadID);
        const opts = {
          winner: (text || "SINZU").slice(0, 40),
          loser: String(p.text2 || "").trim().slice(0, 40) || "ENEMY",
          reason: String(p.text3 || "").trim().slice(0, 200),
          seconds: Math.max(MIN_COUNT_SEC, Number(p.seconds) || 2)
        };
        runCount(api, threadID, opts, job).catch(e => console.error("[GROUP] count error:", e?.message || e));
        return { started: true };
      }
      throw new Error("Unknown feature");
    }
    case "feature-stop": {
      const f = String(p.feature || "");
      if (f === "lock") return dashboardAction(api, botID, "gcname-unlock", { threadID });
      if (f === "cycle") return dashboardAction(api, botID, "cycle-stop", { threadID });
      if (f === "nick" || f === "count") { cancelJob(f, threadID); return { stopped: true }; }
      throw new Error("Unknown feature");
    }

    default:
      throw new Error("Unknown action: " + action);
  }
}

function overview() {
  return {
    locked_threads: Object.keys(locks).length,
    cycles_running: cycles.size,
    jobs_running: jobs.size,
    cycle_threads: [...cycles.keys()]
  };
}

module.exports = { handleEvent, dashboardAction, listGroups, overview, threadState };
