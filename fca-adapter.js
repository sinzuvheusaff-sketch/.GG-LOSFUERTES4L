"use strict";

/**
 * fca-adapter.js: the ONLY file that knows which Facebook chat library is used.
 *
 * Why: unofficial Messenger libraries break whenever Facebook changes something.
 * Everything in the bot talks to this file, so when ws3-fca dies you swap or
 * update ONE thing instead of touching the whole bot.
 *
 * Library order (first one that loads wins). Override with an env variable:
 *   FCA_PACKAGES=ws3-fca,some-other-fca
 * Fallback packages are optional: only used if you have installed them.
 *
 * Exposes:
 *   login(cookieString, callback)  same signature the bot already uses
 *   isAuthError(error)             true for checkpoint / expired / logged-out errors
 *   REQUIRED_METHODS               what the bot needs from the library
 */

const PACKAGES = String(process.env.FCA_PACKAGES || "ws3-fca")
  .split(",").map(s => s.trim()).filter(Boolean);

// Errors that mean "this Facebook session is dead". Retrying with another library
// will not help and only hammers Facebook, so we never fall back on these.
const AUTH_ERROR_RE =
  /not logged in|checkpoint|login approval|two.?factor|session.*(expired|invalid)|invalid.*(session|cookie)|expired.*(session|cookie)|authentication|incorrect.*password|account.*(locked|disabled|suspended)/i;

// The bot (index.js + group-controls.js + banat-human.js) uses only these.
const REQUIRED_METHODS = [
  "listenMqtt", "sendMessage", "getCurrentUserID", "getUserInfo",
  "getThreadInfo", "getThreadList", "setTitle", "changeNickname"
];

function isAuthError(error) {
  let text = "";
  try { text = typeof error === "string" ? error : JSON.stringify(error) + " " + (error?.message || ""); }
  catch (_) { text = String(error); }
  return AUTH_ERROR_RE.test(text);
}

function loadPackages() {
  const loaded = [];
  for (const name of PACKAGES) {
    try {
      const mod = require(name);
      const fn = typeof mod === "function" ? mod : (mod.login || mod.default);
      if (typeof fn === "function") loaded.push({ name, login: fn });
      else console.warn(`[FCA] ${name} loaded but has no login()`);
    } catch (error) {
      console.warn(`[FCA] ${name} not available: ${error?.message || error}`);
    }
  }
  return loaded;
}

const libs = loadPackages();

function checkApi(name, api) {
  const missing = REQUIRED_METHODS.filter(m => typeof api?.[m] !== "function");
  if (missing.length) console.warn(`[FCA] ${name} is missing: ${missing.join(", ")} (those features will not work)`);
  try { Object.defineProperty(api, "__fca", { value: name, enumerable: false }); } catch (_) {}
  return api;
}

function login(cookie, callback) {
  if (!libs.length) {
    callback(new Error(`No Facebook chat library available (tried: ${PACKAGES.join(", ")}). Run npm install.`));
    return;
  }

  let index = 0;
  let finished = false;
  const finish = (error, api, name) => {
    if (finished) return;
    finished = true;
    callback(error, error ? undefined : checkApi(name, api));
  };

  const attempt = () => {
    const lib = libs[index];
    let settled = false;
    const next = (error) => {
      // Dead session -> report immediately. Other failure -> try the next library.
      if (isAuthError(error) || index + 1 >= libs.length) return finish(error);
      console.warn(`[FCA] ${lib.name} failed (${error?.message || error}); trying ${libs[index + 1].name}`);
      index++;
      attempt();
    };

    try {
      const returned = lib.login(cookie, (error, api) => {
        if (settled) return;
        settled = true;
        if (error || !api) return next(error || new Error("login returned no api"));
        finish(null, api, lib.name);
      });
      if (returned && typeof returned.then === "function") {
        returned.then(
          api => { if (!settled) { settled = true; finish(null, api, lib.name); } },
          error => { if (!settled) { settled = true; next(error); } }
        );
      }
    } catch (error) {
      if (!settled) { settled = true; next(error); }
    }
  };

  attempt();
}

module.exports = { login, isAuthError, REQUIRED_METHODS, packages: PACKAGES };
