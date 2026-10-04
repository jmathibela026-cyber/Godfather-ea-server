// ICT Liquidity Sweep strategy (HTF sweep -> LTF CHoCH -> entry on OB/FVG/OTE).
// Pure functions: candles in, a signal (or null) out. No network, no state.
//
// Rules (as agreed):
//  1. HTF (H4): a candle wicks beyond a prior swing high/low (liquidity) and closes back inside.
//  2. LTF (M15): after the sweep extreme, price breaks the last minor swing in the opposite
//     direction with a candle close (CHoCH).
//  3. Entry: midpoint of the order block / fair value gap. If that midpoint is NOT inside the
//     OTE zone (61.8%-78.6% retracement of the leg), the OTE level (70.5%) is used instead.
//  4. Stop loss just beyond the order block.
//  5. Take profit at the next HTF swing point in the trade direction.
//
// Candles: [{ time: ms, open, high, low, close }], oldest first, CLOSED candles only.
// BUY setups are found by mirroring prices and running the SELL logic, so there is one code path.

const H4_MS = 4 * 3600 * 1000;

const DEFAULTS = {
  swingLen: 2,        // candles each side that define a swing point
  h4Lookback: 40,     // how far back (H4 candles) a swept swing may be
  maxSweepAge: 3,     // the sweep candle must be one of the last N closed H4 candles
  maxSetupAgeM15: 40, // CHoCH must be no older than this many M15 candles (10 hours)
  minRR: 1.5,         // skip setups with less reward than this multiple of the risk
  oteLow: 0.618,
  oteHigh: 0.786,
  oteMid: 0.705,
  slBufferAtr: 0.1,   // stop buffer beyond the order block, as a fraction of M15 ATR
  minStopAtr: 0.5,    // never use a stop tighter than this (fraction of M15 ATR)
  atrPeriod: 14,
};

function swingHighs(c, L) {
  const out = [];
  for (let i = L; i < c.length - L; i++) {
    let ok = true;
    for (let j = 1; j <= L; j++) {
      if (!(c[i].high > c[i - j].high && c[i].high > c[i + j].high)) { ok = false; break; }
    }
    if (ok) out.push(i);
  }
  return out;
}
function swingLows(c, L) {
  const out = [];
  for (let i = L; i < c.length - L; i++) {
    let ok = true;
    for (let j = 1; j <= L; j++) {
      if (!(c[i].low < c[i - j].low && c[i].low < c[i + j].low)) { ok = false; break; }
    }
    if (ok) out.push(i);
  }
  return out;
}
function atr(c, n) {
  const s = c.slice(-(n + 1));
  if (s.length < 2) return 0;
  let sum = 0;
  for (let i = 1; i < s.length; i++) {
    sum += Math.max(s[i].high - s[i].low, Math.abs(s[i].high - s[i - 1].close), Math.abs(s[i].low - s[i - 1].close));
  }
  return sum / (s.length - 1);
}
const mirror = (c) => c.map((x) => ({ time: x.time, open: -x.open, high: -x.low, low: -x.high, close: -x.close }));

// SELL setup on (possibly mirrored) candles. Returns raw numbers or null.
function findSell(h4, m15, spread, o) {
  const L = o.swingLen;
  const n4 = h4.length, n15 = m15.length;
  if (n4 < 30 || n15 < 40) return null;
  const a15 = atr(m15, o.atrPeriod);
  if (!(a15 > 0)) return null;

  for (let back = 0; back < o.maxSweepAge; back++) {
    const s = n4 - 1 - back;
    if (s < 25) break;

    // 1) HTF sweep: wick above an untouched swing high, close back below it
    const highs = swingHighs(h4.slice(0, s), L).filter((j) => j >= s - o.h4Lookback);
    let lvl = null;
    for (let q = highs.length - 1; q >= 0; q--) {
      const j = highs[q], price = h4[j].high;
      const untouched = h4.slice(j + 1, s).every((x) => x.high <= price);
      if (untouched && h4[s].high > price && h4[s].close < price) { lvl = price; break; }
    }
    if (lvl === null) continue;

    // 2) LTF: extreme inside the sweep candle, then a CHoCH
    const start = h4[s].time, end = start + H4_MS;
    let iw = m15.findIndex((x) => x.time >= start);
    if (iw < 0) continue;
    let e = -1, eh = -Infinity;
    for (let i = iw; i < n15 && m15[i].time < end; i++) if (m15[i].high > eh) { eh = m15[i].high; e = i; }
    if (e < 0) continue;

    const lows = swingLows(m15.slice(0, e), L).filter((p) => p >= e - 30);
    if (!lows.length) continue;
    const chochLevel = m15[lows[lows.length - 1]].low;
    let k = -1;
    for (let i = e + 1; i < n15; i++) if (m15[i].close < chochLevel) { k = i; break; }
    if (k < 0 || n15 - 1 - k > o.maxSetupAgeM15) continue;

    // 3) Leg, OB, FVG, OTE
    const H = m15[e].high;
    let Ll = Infinity;
    for (let i = e; i < n15; i++) Ll = Math.min(Ll, m15[i].low);
    const range = H - Ll;
    if (!(range > 0)) continue;

    let ob = m15[e];
    for (let i = k - 1; i >= e; i--) if (m15[i].close > m15[i].open) { ob = m15[i]; break; }
    const obMid = (ob.high + ob.low) / 2;

    let fvg = null;
    for (let i = e + 1; i < n15 - 1; i++) {
      if (m15[i - 1].low > m15[i + 1].high) {
        const g = { lo: m15[i + 1].high, hi: m15[i - 1].low };
        if (!fvg || g.hi - g.lo > fvg.hi - fvg.lo) fvg = g;
      }
    }
    let base = obMid;
    if (fvg && fvg.lo <= ob.high && fvg.hi >= ob.low) base = (obMid + (fvg.lo + fvg.hi) / 2) / 2;

    const oteLo = Ll + o.oteLow * range, oteHi = Ll + o.oteHigh * range;
    const entry = base >= oteLo && base <= oteHi ? base : Ll + o.oteMid * range;

    // entry must still be waiting: price has not already tapped it since the CHoCH
    let tapped = false;
    for (let i = k; i < n15; i++) if (m15[i].high >= entry) { tapped = true; break; }
    if (tapped) continue;

    // 4) Stop beyond the order block (+ spread, since sells stop out on the ask)
    const buf = Math.max(o.slBufferAtr * a15, 0) + spread;
    let sl = Math.max(ob.high, entry) + buf;
    if (sl - entry < o.minStopAtr * a15) sl = entry + o.minStopAtr * a15;
    if (sl > H + a15) continue; // stop would be absurdly far beyond the sweep: skip

    // 5) Take profit: nearest HTF swing low below entry
    const tpCands = swingLows(h4, L).map((j) => h4[j].low).filter((p) => p < entry);
    if (!tpCands.length) continue;
    const tp = Math.max(...tpCands);
    const rr = (entry - tp) / (sl - entry);
    if (!(rr >= o.minRR)) continue;

    return { entry, sl, tp, rr, sweepTime: h4[s].time, sweptLevel: lvl, expiresAt: m15[n15 - 1].time + 8 * 3600 * 1000 };
  }
  return null;
}

// Returns { side, entry, sl, tp, rr, key, expiresAt } or null.
function evaluate({ h4, m15, spread = 0, allow = "BOTH", options = {} }) {
  const o = { ...DEFAULTS, ...options };
  const out = [];
  if (allow === "BOTH" || allow === "SELL") {
    const r = findSell(h4, m15, spread, o);
    if (r) out.push({ side: "SELL", ...r });
  }
  if (allow === "BOTH" || allow === "BUY") {
    const r = findSell(mirror(h4), mirror(m15), spread, o);
    if (r) out.push({ side: "BUY", entry: -r.entry, sl: -r.sl, tp: -r.tp, rr: r.rr, sweepTime: r.sweepTime, sweptLevel: -r.sweptLevel, expiresAt: r.expiresAt });
  }
  if (!out.length) return null;
  out.sort((a, b) => b.sweepTime - a.sweepTime); // most recent sweep wins
  const s = out[0];
  return { ...s, key: s.side + ":" + s.sweepTime };
}

module.exports = { evaluate, DEFAULTS, swingHighs, swingLows, atr, H4_MS };
