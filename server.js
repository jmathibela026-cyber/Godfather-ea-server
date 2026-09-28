// EA App server: Node.js + Express + PostgreSQL
// npm install express pg
// env: DATABASE_URL, KEY_SECRET, MT_SECRET, ADMIN_TOKEN

const express = require("express");
const crypto = require("crypto");
const { Pool } = require("pg");
const { registerMtRoutes } = require("./mt");

const app = express();
app.use(require("./cors").corsMiddleware);
app.use(express.json());
const db = new Pool({ connectionString: process.env.DATABASE_URL });

// Sends async errors to the error handler instead of crashing the server
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// ---------- helpers ----------

const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
function generateKey() {
  const bytes = crypto.randomBytes(16);
  let raw = "";
  for (let i = 0; i < 16; i++) raw += ALPHABET[bytes[i] % ALPHABET.length];
  return "EA-" + raw.match(/.{4}/g).join("-");
}

function hashKey(key) {
  const clean = String(key).trim().toUpperCase();
  return crypto.createHmac("sha256", process.env.KEY_SECRET).update(clean).digest("hex");
}

const auth = require("./auth").makeAuth(db);
const requireUser = auth.requireUser;

function requireAdmin(req, res, next) {
  const token = req.header("x-admin-token") || "";
  const ok =
    token.length === process.env.ADMIN_TOKEN.length &&
    crypto.timingSafeEqual(Buffer.from(token), Buffer.from(process.env.ADMIN_TOKEN));
  if (!ok) return res.status(403).json({ error: "Forbidden" });
  next();
}

// The Quotes screen list. Brokers name symbols differently (EURUSD.m, EURUSDpro...),
// so map these to the user's broker names when a bot starts.
const SYMBOLS = {
  "Forex majors": ["EURUSD", "GBPUSD", "USDJPY", "USDCHF", "AUDUSD", "USDCAD", "NZDUSD"],
  Others: ["EURGBP", "EURJPY", "GBPJPY", "XAUUSD", "US30", "NAS100", "BTCUSD"],
};
const ALL_SYMBOLS = new Set(Object.values(SYMBOLS).flat());

// A user's connection to a bot (id = user_bots.id)
async function getOwnedBot(userBotId, userId) {
  if (!Number.isInteger(Number(userBotId))) return undefined;
  const { rows } = await db.query(
    `SELECT ub.id, ub.symbols, b.id AS bot_id, b.name, b.author, b.image_path, b.file_path, b.platform
     FROM user_bots ub JOIN bots b ON b.id = ub.bot_id
     WHERE ub.id = $1 AND ub.user_id = $2`,
    [userBotId, userId]
  );
  return rows[0];
}

async function checkLicense(userBotId) {
  const { rows } = await db.query(
    `SELECT k.status, k.expires_at FROM user_bots ub
     JOIN license_keys k ON k.id = ub.key_id WHERE ub.id = $1`,
    [userBotId]
  );
  const k = rows[0];
  if (!k) return { valid: false, reason: "no_key" };
  if (k.status === "revoked") return { valid: false, reason: "revoked" };
  if (k.expires_at && new Date(k.expires_at) <= new Date()) return { valid: false, reason: "expired" };
  return { valid: true, expiresAt: k.expires_at };
}

// ---------- admin: bots and keys ----------

// POST /admin/bots { name, author, imagePath, filePath, platform: "mt5" | "mt4" }
// (file upload itself: store the .ex4/.ex5 and the cover image in your storage, then pass their paths)
app.post("/admin/bots", requireAdmin, wrap(async (req, res) => {
  const { name, author = "", imagePath = null, filePath } = req.body;
  const platform = String(req.body.platform || "mt5").toLowerCase();
  if (!name || !filePath) return res.status(400).json({ error: "name and filePath are required" });
  if (!["mt4", "mt5"].includes(platform)) return res.status(400).json({ error: "platform must be mt4 or mt5" });
  const { rows } = await db.query(
    "INSERT INTO bots (name, author, image_path, file_path, platform) VALUES ($1, $2, $3, $4, $5) RETURNING id",
    [name, author, imagePath, filePath, platform]
  );
  res.json({ botId: rows[0].id });
}));

// POST /admin/keys { botId, count, expiresInDays } -> plaintext keys returned ONCE
app.post("/admin/keys", requireAdmin, wrap(async (req, res) => {
  const bot = await db.query("SELECT id FROM bots WHERE id = $1", [req.body.botId]);
  if (!bot.rows[0]) return res.status(400).json({ error: "Unknown botId" });
  const count = Math.min(Number(req.body.count) || 1, 500);
  const days = Number(req.body.expiresInDays) || null;
  const keys = [];
  for (let i = 0; i < count; i++) {
    const key = generateKey();
    await db.query(
      `INSERT INTO license_keys (key_hash, bot_id, expires_at)
       VALUES ($1, $2, CASE WHEN $3::int IS NULL THEN NULL ELSE now() + ($3::int * interval '1 day') END)`,
      [hashKey(key), bot.rows[0].id, days]
    );
    keys.push(key);
  }
  res.json({ keys });
}));

app.post("/admin/keys/revoke", requireAdmin, wrap(async (req, res) => {
  const { rowCount } = await db.query(
    "UPDATE license_keys SET status = 'revoked', revoked_at = now() WHERE key_hash = $1",
    [hashKey(req.body.key)]
  );
  res.json({ revoked: rowCount === 1 });
}));

app.post("/admin/keys/extend", requireAdmin, wrap(async (req, res) => {
  const days = Number(req.body.days);
  if (!days) return res.status(400).json({ error: "days required" });
  const { rowCount } = await db.query(
    `UPDATE license_keys
     SET expires_at = GREATEST(COALESCE(expires_at, now()), now()) + ($2::int * interval '1 day')
     WHERE key_hash = $1 AND status <> 'revoked'`,
    [hashKey(req.body.key), days]
  );
  res.json({ extended: rowCount === 1 });
}));

// ---------- user: redeem a key, see and manage my bots ----------

// POST /keys/redeem { key } -> the bot appears on the Home screen
app.post("/keys/redeem", requireUser, wrap(async (req, res) => {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    // One atomic UPDATE: two people can't redeem the same key at once
    const k = await client.query(
      `UPDATE license_keys
       SET status = 'redeemed', redeemed_by = $2, redeemed_at = now()
       WHERE key_hash = $1 AND status = 'unused' AND (expires_at IS NULL OR expires_at > now())
       RETURNING id, bot_id`,
      [hashKey(req.body.key), req.user.id]
    );
    // Same message for wrong / used / expired / revoked keys: don't help guessers
    if (!k.rows[0]) { await client.query("ROLLBACK"); return res.status(400).json({ error: "Invalid or unavailable key" }); }

    let ub;
    try {
      ub = await client.query(
        "INSERT INTO user_bots (user_id, bot_id, key_id) VALUES ($1, $2, $3) RETURNING id",
        [req.user.id, k.rows[0].bot_id, k.rows[0].id]
      );
    } catch (e) {
      if (e.code === "23505") { await client.query("ROLLBACK"); return res.status(400).json({ error: "You already have this bot" }); }
      throw e;
    }
    await client.query("COMMIT");
    res.json({ added: true, myBotId: ub.rows[0].id });
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}));

// GET /my/bots -> everything the Home screen shows
app.get("/my/bots", requireUser, wrap(async (req, res) => {
  const { rows } = await db.query(
    `SELECT ub.id, b.name, b.author, b.image_path, b.platform, ub.symbols, k.expires_at,
            (SELECT r.status FROM bot_runs r WHERE r.user_bot_id = ub.id ORDER BY r.id DESC LIMIT 1) AS run_status
     FROM user_bots ub
     JOIN bots b ON b.id = ub.bot_id
     JOIN license_keys k ON k.id = ub.key_id
     WHERE ub.user_id = $1 ORDER BY ub.id`,
    [req.user.id]
  );
  res.json({ bots: rows });
}));

// DELETE /my/bots/:id -> Remove button. The app then shows the "add license key" page.
// The key stays used (it is not freed for reuse), so a key can't be passed on.
app.delete("/my/bots/:id", requireUser, wrap(async (req, res) => {
  const bot = await getOwnedBot(req.params.id, req.user.id);
  if (!bot) return res.status(404).json({ error: "Bot not found" });
  const active = await db.query(
    "SELECT 1 FROM bot_runs WHERE user_bot_id = $1 AND status IN ('starting', 'running', 'stopping')",
    [bot.id]
  );
  if (active.rows[0]) return res.status(409).json({ error: "Stop the bot before removing it" });
  await db.query("DELETE FROM user_bots WHERE id = $1", [bot.id]); // run history goes with it
  res.json({ removed: true });
}));

// ---------- quotes: choose and save symbols ----------

app.get("/symbols", requireUser, (req, res) => res.json({ groups: SYMBOLS }));

// PUT /my/bots/:id/symbols { symbols: [{ symbol: "XAUUSD", lot: 0.01, action: "BOTH" }] }
// This is the Assets screen: the allowed symbols, each with a lot size and BUY / SELL / BOTH.
app.put("/my/bots/:id/symbols", requireUser, wrap(async (req, res) => {
  const bot = await getOwnedBot(req.params.id, req.user.id);
  if (!bot) return res.status(404).json({ error: "Bot not found" });

  const active = await db.query(
    "SELECT 1 FROM bot_runs WHERE user_bot_id = $1 AND status IN ('starting', 'running', 'stopping')",
    [bot.id]
  );
  if (active.rows[0]) return res.status(409).json({ error: "Stop the bot before changing symbols" });

  const input = Array.isArray(req.body.symbols) ? req.body.symbols : null;
  if (!input || input.length > 30) return res.status(400).json({ error: "Invalid symbol list" });

  const seen = new Set();
  const list = [];
  for (const item of input) {
    const symbol = String(item && item.symbol);
    const lot = Math.round(Number(item && item.lot) * 100) / 100;
    const action = String((item && item.action) || "").toUpperCase();
    if (!ALL_SYMBOLS.has(symbol) || seen.has(symbol)) return res.status(400).json({ error: "Invalid symbol list" });
    if (!(lot >= 0.01 && lot <= 100)) return res.status(400).json({ error: "Lot size must be between 0.01 and 100" });
    if (!["BUY", "SELL", "BOTH"].includes(action)) return res.status(400).json({ error: "Action must be BUY, SELL or BOTH" });
    seen.add(symbol);
    list.push({ symbol, lot, action });
  }
  await db.query("UPDATE user_bots SET symbols = $2 WHERE id = $1", [bot.id, JSON.stringify(list)]);
  res.json({ saved: list.length });
}));

// GET /my/bots/:id/license
app.get("/my/bots/:id/license", requireUser, wrap(async (req, res) => {
  const bot = await getOwnedBot(req.params.id, req.user.id);
  if (!bot) return res.status(404).json({ error: "Bot not found" });
  res.json(await checkLicense(bot.id));
}));

// ---------- other route files ----------

auth.registerRoutes(app, { requireAdmin });                    // login + admin users
registerMtRoutes(app, { db, requireUser, wrap });              // MetaTrader account
require("./runs").registerRunRoutes(app, { db, requireUser, getOwnedBot, checkLicense, wrap }); // start / stop / status

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: "Server error" });
});

app.listen(process.env.PORT || 3000, () => console.log("Server running"));
