// Runner: runs the Godfather ICT strategy for one bot on one MetaTrader account through MetaApi.
// The server does the work, so the bot keeps going when the phone app is closed.
//
// env:
//   METAAPI_TOKEN   your MetaApi API token (required)
//   LIVE_TRADING    "true" to place real orders. Anything else = DRY RUN: signals are
//                   logged and shown in the status activity, but NO orders are sent.
//   MIN_RR          optional, minimum reward:risk to take a setup (default 1.5)
//
// What it touches on the broker account: only orders/positions whose comment is "Godfather".
// Your manual trades are never closed or cancelled by this bot.
//
// The account password is passed to MetaApi once (to create/update the cloud account) and is
// never logged or stored by this file.

const { evaluate } = require("./strategy");

const COMMENT = "Godfather";
const MAGIC = 20260105;
const TICK_MS = 20 * 1000;
const M15_MS = 15 * 60 * 1000;
const H4_MS = 4 * 3600 * 1000;
const PENDING_LIFETIME_MS = 8 * 3600 * 1000;

const runs = new Map(); // accountId -> state

const isLive = () => process.env.LIVE_TRADING === "true";

function userError(msg, cause) {
  const e = new Error(msg);
  e.userMessage = msg;
  if (cause) e.cause = cause;
  return e;
}

let apiFactory = () => {
  if (!process.env.METAAPI_TOKEN) throw userError("MetaApi is not set up on the server (METAAPI_TOKEN missing)");
  const MetaApi = require("metaapi.cloud-sdk").default;
  return new MetaApi(process.env.METAAPI_TOKEN);
};
let api = null;
const getApi = () => api || (api = apiFactory());
function _setApiFactory(f) { apiFactory = f; api = null; }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function log(state, msg) {
  const line = { t: new Date().toISOString(), msg };
  state.activity.push(line);
  if (state.activity.length > 30) state.activity.shift();
  console.log("[runner " + state.accountId + "] " + msg);
}

function explainCreateError(e) {
  const text = (e && (e.message || "")) + " " + JSON.stringify((e && e.details) || "");
  if (/E_AUTH/.test(text)) return "Your broker refused the login. Check your MT login, password and server name.";
  if (/E_SRV_NOT_FOUND/.test(text)) return "Broker server name not found. Check it matches your MT server exactly.";
  if (/E_RESOURCE_SLOTS/.test(text)) return "Your MetaApi plan has no free account slot.";
  if (/E_SERVER_TIMEZONE/.test(text)) return "MetaApi could not detect your broker's settings. Try again in a few minutes.";
  return "Could not connect your MetaTrader account through MetaApi.";
}

// Find the MetaApi cloud account for this login/server, or create it. Then make sure it is deployed.
async function ensureAccount({ platform, login, server, password }) {
  const mapi = getApi().metatraderAccountApi;
  let list = await mapi.getAccountsWithInfiniteScrollPagination({ limit: 50, query: String(login) });
  list = Array.isArray(list) ? list : (list && list.items) || [];
  let acc = list.find((a) => String(a.login) === String(login) && a.server === server);
  if (acc) {
    try { await acc.update({ name: "Godfather " + login, password, server }); }
    catch (e) { console.error("Account update failed:", e && e.message); }
  } else {
    try {
      acc = await mapi.createAccount({
        name: "Godfather " + login, type: "cloud", login: String(login), password, server,
        platform, magic: MAGIC, application: "MetaApi",
      });
    } catch (e) {
      throw userError(explainCreateError(e), e);
    }
  }
  if (acc.state !== "DEPLOYED") await acc.deploy();
  return acc;
}

function normalizeSymbols(list) {
  return (list || []).map((s) => ({
    symbol: String(s.symbol), lot: Number(s.lot) || 0.01,
    action: ["BUY", "SELL", "BOTH"].includes(String(s.action).toUpperCase()) ? String(s.action).toUpperCase() : "BOTH",
    broker: null, spec: null, skip: false,
  }));
}

function newState(accountId, account, symbols) {
  return { accountId, account, connection: null, symbols: normalizeSymbols(symbols), timer: null, busy: false,
           paused: false, resolved: false, lastBucket: {}, handled: new Set(), activity: [] };
}

async function ensureConnection(state) {
  if (state.connection) return state.connection;
  const c = state.account.getRPCConnection();
  await c.connect();
  await c.waitSynchronized();
  state.connection = c;
  log(state, "Connected to your MetaTrader account");
  return c;
}

async function resolveSymbols(state) {
  if (state.resolved) return;
  const c = state.connection;
  let all = null;
  try { all = await c.getSymbols(); } catch (_) { all = null; }
  for (const s of state.symbols) {
    if (Array.isArray(all) && all.length) {
      const exact = all.find((x) => x === s.symbol);
      const near = all.filter((x) => x.toUpperCase().startsWith(s.symbol.toUpperCase())).sort((a, b) => a.length - b.length)[0];
      s.broker = exact || near || null;
    } else {
      s.broker = s.symbol;
    }
    if (!s.broker) { s.skip = true; log(state, s.symbol + " was not found at your broker. Skipped."); continue; }
    try { s.spec = await c.getSymbolSpecification(s.broker); } catch (_) { s.spec = {}; }
  }
  state.resolved = true;
}

function toCandles(raw, tfMs, now) {
  return (raw || [])
    .map((x) => ({ time: +new Date(x.time), open: x.open, high: x.high, low: x.low, close: x.close }))
    .filter((x) => Number.isFinite(x.time) && x.time + tfMs <= now) // closed candles only
    .sort((a, b) => a.time - b.time);
}

function fixVolume(lot, spec) {
  const step = Number(spec && spec.volumeStep) || 0.01;
  const min = Number(spec && spec.minVolume) || step;
  const max = Number(spec && spec.maxVolume) || 100;
  let v = Math.round(lot / step) * step;
  v = Math.min(max, Math.max(min, v));
  const dec = (String(step).split(".")[1] || "").length;
  return Number(v.toFixed(dec));
}
const roundPrice = (p, spec) => Number(p.toFixed(Number.isInteger(spec && spec.digits) ? spec.digits : 5));
const isMine = (o, broker) => o.symbol === broker && String(o.comment || "").includes(COMMENT);

async function processSymbol(state, s) {
  const now = Date.now();
  const bucket = Math.floor(now / M15_MS) * M15_MS;
  if (state.lastBucket[s.symbol] === bucket || now - bucket < 3000) return; // once per closed M15 candle

  const c = state.connection;
  const [rawH4, rawM15] = await Promise.all([
    state.account.getHistoricalCandles(s.broker, "4h", undefined, 80),
    state.account.getHistoricalCandles(s.broker, "15m", undefined, 200),
  ]);
  const h4 = toCandles(rawH4, H4_MS, now), m15 = toCandles(rawM15, M15_MS, now);

  // Wait for the candle that just closed to appear; give up after 5 minutes (market closed)
  if (!m15.length || m15[m15.length - 1].time < bucket - M15_MS) {
    if (now - bucket > 5 * 60 * 1000) state.lastBucket[s.symbol] = bucket;
    return;
  }

  const price = await c.getSymbolPrice(s.broker);
  const spread = price && price.ask > price.bid ? price.ask - price.bid : 0;

  const orders = (await c.getOrders()) || [];
  const positions = (await c.getPositions()) || [];
  const myOrders = orders.filter((o) => isMine(o, s.broker));
  const myPositions = positions.filter((p) => isMine(p, s.broker));

  // Housekeeping on our pending entries: cancel if expired or if price already ran through the stop
  for (const o of myOrders) {
    const isSell = String(o.type).includes("SELL");
    const dead = (o.stopLoss && (isSell ? price.bid >= o.stopLoss : price.ask <= o.stopLoss)) ||
                 (o.expirationTime && +new Date(o.expirationTime) < now) ||
                 (o.time && now - +new Date(o.time) > PENDING_LIFETIME_MS + 5 * 60 * 1000);
    if (dead && isLive()) {
      await c.cancelOrder(o.id);
      log(state, s.symbol + ": cancelled an entry that was no longer valid");
    }
  }

  state.lastBucket[s.symbol] = bucket;
  if (myPositions.length || myOrders.length) return; // one trade per symbol

  const sig = evaluate({ h4, m15, spread, allow: s.action, options: process.env.MIN_RR ? { minRR: Number(process.env.MIN_RR) } : {} });
  if (!sig) return;
  const key = s.symbol + ":" + sig.key;
  if (state.handled.has(key)) return;
  state.handled.add(key);

  if ((sig.side === "SELL" && sig.entry <= price.bid) || (sig.side === "BUY" && sig.entry >= price.ask)) {
    log(state, s.symbol + ": " + sig.side + " setup found but price is already past the entry. Skipped.");
    return;
  }

  const spec = s.spec || {};
  const entry = roundPrice(sig.entry, spec), sl = roundPrice(sig.sl, spec), tp = roundPrice(sig.tp, spec);
  const vol = fixVolume(s.lot, spec);
  const desc = s.symbol + ": " + sig.side + " " + vol + " lots, entry " + entry + ", SL " + sl + ", TP " + tp + ", RR " + sig.rr.toFixed(1);

  if (!isLive()) { log(state, "DRY RUN (no order sent) " + desc); return; }
  const opts = { comment: COMMENT, expiration: { type: "ORDER_TIME_SPECIFIED", time: new Date(now + PENDING_LIFETIME_MS) } };
  if (sig.side === "SELL") await c.createLimitSellOrder(s.broker, vol, entry, sl, tp, opts);
  else await c.createLimitBuyOrder(s.broker, vol, entry, sl, tp, opts);
  log(state, "Order placed. " + desc);
}

async function tick(state) {
  if (state.busy || state.paused || state.stopped) return;
  state.busy = true;
  try {
    await ensureConnection(state);
    await resolveSymbols(state);
    for (const s of state.symbols) {
      if (s.skip || state.paused || state.stopped) continue;
      try { await processSymbol(state, s); }
      catch (e) { log(state, s.symbol + ": error: " + String((e && e.message) || e).slice(0, 160)); }
    }
  } catch (e) {
    state.connection = null; // reconnect on the next tick
    log(state, "Connection problem, retrying: " + String((e && e.message) || e).slice(0, 160));
  } finally {
    state.busy = false;
  }
}

function launch(state) {
  runs.set(state.accountId, state);
  state.timer = setInterval(() => tick(state), TICK_MS);
  setImmediate(() => tick(state));
  log(state, (isLive() ? "LIVE" : "DRY RUN") + " started for " + state.symbols.map((x) => x.symbol).join(", "));
}

async function startInstance({ settings, account }) {
  const symbols = settings && settings.symbols;
  if (!symbols || !symbols.length) throw userError("Choose your symbols in Quotes first");
  const acc = await ensureAccount(account);
  if (runs.has(acc.id)) throw userError("Bot is already running");
  launch(newState(acc.id, acc, symbols));
  return "metaapi:" + acc.id;
}

// After a server restart the loops are gone; runs.js calls this for every run still marked running.
async function resumeInstance({ instanceId, settings }) {
  const accountId = String(instanceId).split(":")[1];
  if (!accountId || runs.has(accountId)) return;
  const acc = await getApi().metatraderAccountApi.getAccount(accountId);
  if (acc.state !== "DEPLOYED") await acc.deploy();
  launch(newState(accountId, acc, settings && settings.symbols));
}

async function stopInstance({ instanceId, mode }) {
  const accountId = String(instanceId).split(":")[1];
  const state = runs.get(accountId) || null;

  if (state) { // pause the loop and let any running tick finish
    state.paused = true;
    for (let i = 0; i < 90 && state.busy; i++) await sleep(1000);
  }
  try {
    const acc = state ? state.account : await getApi().metatraderAccountApi.getAccount(accountId);
    let c = state && state.connection;
    try {
      if (!c) { c = acc.getRPCConnection(); await c.connect(); await c.waitSynchronized(); }
      const mine = (x) => String(x.comment || "").includes(COMMENT);
      // Unfilled entries are always cancelled: they would open trades nobody is managing
      for (const o of ((await c.getOrders()) || []).filter(mine)) await c.cancelOrder(o.id);
      if (mode === "close_all") {
        for (const p of ((await c.getPositions()) || []).filter(mine)) await c.closePosition(p.id);
        const left = ((await c.getPositions()) || []).filter(mine);
        if (left.length) throw new Error(left.length + " trade(s) did not close");
      }
    } catch (e) {
      if (isLive() || mode === "close_all") throw e; // never shut down while trades may be unmanaged
      console.error("Stop (dry run): could not reach account, continuing:", e && e.message);
    }
    if (state) { clearInterval(state.timer); state.stopped = true; runs.delete(accountId); }
    try { await acc.undeploy(); } catch (e) { console.error("Undeploy failed:", e && e.message); }
  } catch (e) {
    if (state) state.paused = false; // stay running so the user can retry
    throw e;
  }
}

function getActivity(instanceId) {
  const state = runs.get(String(instanceId || "").split(":")[1]);
  return state ? state.activity.slice(-15) : [];
}

module.exports = { startInstance, stopInstance, resumeInstance, getActivity, _setApiFactory, _runs: runs, _tick: tick };
