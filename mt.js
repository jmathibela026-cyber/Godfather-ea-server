// MetaTrader accounts: a user can save one MT5 account and one MT4 account.
// A bot uses the account that matches its platform (.ex5 -> MT5, .ex4 -> MT4).
// The password is encrypted (AES-256-GCM) and is NEVER sent back to the app.
// env: MT_SECRET (long random string, different from KEY_SECRET; back it up, because
// if it is lost the saved passwords cannot be decrypted)
const crypto = require("crypto");

const boxKey = () => crypto.createHash("sha256").update(process.env.MT_SECRET).digest();

function encrypt(text) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", boxKey(), iv);
  const enc = Buffer.concat([c.update(text, "utf8"), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), enc]).toString("base64");
}

function decrypt(b64) {
  const buf = Buffer.from(b64, "base64");
  const d = crypto.createDecipheriv("aes-256-gcm", boxKey(), buf.subarray(0, 12));
  d.setAuthTag(buf.subarray(12, 28));
  return Buffer.concat([d.update(buf.subarray(28)), d.final()]).toString("utf8");
}

function registerMtRoutes(app, { db, requireUser, wrap }) {
  // Is a bot of this platform running for this user?
  const hasActiveRun = async (userId, platform) => {
    const { rows } = await db.query(
      `SELECT 1 FROM bot_runs r
       JOIN user_bots ub ON ub.id = r.user_bot_id
       JOIN bots b ON b.id = ub.bot_id
       WHERE ub.user_id = $1 AND b.platform = $2 AND r.status IN ('starting', 'running', 'stopping') LIMIT 1`,
      [userId, platform]
    );
    return rows.length > 0;
  };

  // GET /my/mt-account -> { accounts: [{ platform, login, server }] }  (never the password)
  app.get("/my/mt-account", requireUser, wrap(async (req, res) => {
    const { rows } = await db.query("SELECT platform, login, server FROM mt_accounts WHERE user_id = $1", [req.user.id]);
    res.json({ accounts: rows });
  }));

  // PUT /my/mt-account { platform: "mt5", login, password, server }
  app.put("/my/mt-account", requireUser, wrap(async (req, res) => {
    const platform = String(req.body.platform || "").toLowerCase();
    const login = String(req.body.login || "").trim();
    const password = String(req.body.password || "");
    const server = String(req.body.server || "").trim();

    if (!["mt4", "mt5"].includes(platform)) return res.status(400).json({ error: "Choose MT4 or MT5" });
    if (!/^\d{4,12}$/.test(login)) return res.status(400).json({ error: "Login must be numbers only" });
    if (!password || password.length > 100) return res.status(400).json({ error: "Enter your password" });
    if (!/^[\w.\- ]{2,100}$/.test(server)) return res.status(400).json({ error: "Enter your broker server" });
    if (await hasActiveRun(req.user.id, platform)) {
      return res.status(409).json({ error: "Stop your " + platform.toUpperCase() + " bots before changing the account" });
    }

    await db.query(
      `INSERT INTO mt_accounts (user_id, platform, login, server, password_enc)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (user_id, platform) DO UPDATE
       SET login = $3, server = $4, password_enc = $5, updated_at = now()`,
      [req.user.id, platform, login, server, encrypt(password)]
    );
    res.json({ saved: true, platform, login, server });
  }));

  // DELETE /my/mt-account?platform=mt5
  app.delete("/my/mt-account", requireUser, wrap(async (req, res) => {
    const platform = String(req.query.platform || "").toLowerCase();
    if (!["mt4", "mt5"].includes(platform)) return res.status(400).json({ error: "Choose MT4 or MT5" });
    if (await hasActiveRun(req.user.id, platform)) {
      return res.status(409).json({ error: "Stop your " + platform.toUpperCase() + " bots before removing the account" });
    }
    await db.query("DELETE FROM mt_accounts WHERE user_id = $1 AND platform = $2", [req.user.id, platform]);
    res.json({ removed: true });
  }));
}

module.exports = { registerMtRoutes, decrypt };
