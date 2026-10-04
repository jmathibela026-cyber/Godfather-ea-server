// Start/stop flow. `:id` in every route is the user's bot connection (user_bots.id).
const runner = require("./runner");
const { decrypt } = require("./mt");

// Trade needs no questions: the strategy comes from the bot itself, the login from the
// MetaTrader screen, and the symbols, lot sizes and actions from the Assets screen.
// Add questions here later only if you need them.
const START_QUESTIONS = [];

function validateAnswers(answers = {}) {
  const settings = {};
  const errors = [];
  for (const q of START_QUESTIONS) {
    const raw = answers[q.id];
    if (raw === undefined || raw === null || String(raw).trim() === "") {
      if (q.required) errors.push(q.label + " is required");
      continue;
    }
    let value = String(raw).trim();
    if (q.type === "number") {
      value = Number(value);
      if (!Number.isFinite(value)) { errors.push(q.label + " must be a number"); continue; }
      if (q.min !== undefined && value < q.min) { errors.push(q.label + " must be at least " + q.min); continue; }
      if (q.max !== undefined && value > q.max) { errors.push(q.label + " must be at most " + q.max); continue; }
    }
    if (q.type === "select" && !q.options.includes(value)) { errors.push(q.label + " has an invalid choice"); continue; }
    settings[q.id] = value;
  }
  return { settings, errors };
}

function registerRunRoutes(app, { db, requireUser, getOwnedBot, checkLicense, wrap }) {
  // Shared by the Stop button and the license sweeper
  async function stopRun(userBotId, mode, reason) {
    const { rows } = await db.query(
      `UPDATE bot_runs SET status = 'stopping', stop_mode = $2, stop_reason = $3
       WHERE user_bot_id = $1 AND status = 'running' RETURNING *`,
      [userBotId, mode, reason]
    );
    const run = rows[0];
    if (!run) return false;
    try {
      await runner.stopInstance({ instanceId: run.instance_id, mode });
      await db.query("UPDATE bot_runs SET status = 'stopped', stopped_at = now() WHERE id = $1", [run.id]);
      return true;
    } catch (e) {
      await db.query("UPDATE bot_runs SET status = 'running' WHERE id = $1", [run.id]);
      throw e;
    }
  }

  app.get("/my/bots/:id/start-questions", requireUser, wrap(async (req, res) => {
    const bot = await getOwnedBot(req.params.id, req.user.id);
    if (!bot) return res.status(404).json({ error: "Bot not found" });
    res.json({ questions: START_QUESTIONS });
  }));

  // POST /my/bots/:id/start { answers: { timeframe: "H1", ... } }   (the Trade button)
  app.post("/my/bots/:id/start", requireUser, wrap(async (req, res) => {
    const bot = await getOwnedBot(req.params.id, req.user.id);
    if (!bot) return res.status(404).json({ error: "Bot not found" });

    const license = await checkLicense(bot.id);
    if (!license.valid) return res.status(403).json({ error: "License " + license.reason });

    const acct = (await db.query(
      "SELECT platform, login, server, password_enc FROM mt_accounts WHERE user_id = $1 AND platform = $2",
      [req.user.id, bot.platform]
    )).rows[0];
    if (!acct) return res.status(400).json({ error: "Add your " + bot.platform.toUpperCase() + " account first" });
    if (!bot.symbols.length) return res.status(400).json({ error: "Choose your symbols in Quotes first" });

    const { settings, errors } = validateAnswers(req.body.answers);
    if (errors.length) return res.status(400).json({ errors });

    // Claim the "active run" slot first; the unique index blocks double starts
    let run;
    try {
      const { rows } = await db.query(
        "INSERT INTO bot_runs (user_bot_id, status, settings) VALUES ($1, 'starting', $2) RETURNING id",
        [bot.id, { ...settings, symbols: bot.symbols }]
      );
      run = rows[0];
    } catch (e) {
      if (e.code === "23505") return res.status(409).json({ error: "Bot is already running" });
      throw e;
    }

    try {
      const instanceId = await runner.startInstance({
        botId: bot.bot_id,
        filePath: bot.file_path,
        settings: { ...settings, symbols: bot.symbols },
        account: { platform: acct.platform, login: acct.login, server: acct.server, password: decrypt(acct.password_enc) },
      });
      await db.query("UPDATE bot_runs SET status = 'running', instance_id = $2 WHERE id = $1", [run.id, instanceId]);
      res.json({ started: true, runId: run.id });
    } catch (e) {
      console.error("Start failed", e.message); // never log the account password
      await db.query("UPDATE bot_runs SET status = 'failed', stopped_at = now() WHERE id = $1", [run.id]);
      res.status(500).json({ error: e.userMessage || "Could not start the bot" });
    }
  }));

  // POST /my/bots/:id/stop { mode: "close_all" | "leave_open" }
  app.post("/my/bots/:id/stop", requireUser, wrap(async (req, res) => {
    const bot = await getOwnedBot(req.params.id, req.user.id);
    if (!bot) return res.status(404).json({ error: "Bot not found" });
    const mode = req.body.mode;
    if (!["close_all", "leave_open"].includes(mode)) return res.status(400).json({ error: "Choose close_all or leave_open" });
    let stopped;
    try { stopped = await stopRun(bot.id, mode, "user"); }
    catch (e) {
      console.error("Stop failed", e.message);
      return res.status(500).json({ error: "Could not stop safely: " + String(e.message || "").slice(0, 120) + ". The bot is still running. Try again." });
    }
    if (!stopped) return res.status(409).json({ error: "Bot is not running" });
    res.json({ stopped: true, mode });
  }));

  // GET /my/bots/:id/status
  app.get("/my/bots/:id/status", requireUser, wrap(async (req, res) => {
    const bot = await getOwnedBot(req.params.id, req.user.id);
    if (!bot) return res.status(404).json({ error: "Bot not found" });
    const { rows } = await db.query(
      "SELECT status, started_at, stopped_at, stop_mode, instance_id FROM bot_runs WHERE user_bot_id = $1 ORDER BY id DESC LIMIT 1",
      [bot.id]
    );
    const acct = await db.query(
      "SELECT 1 FROM mt_accounts WHERE user_id = $1 AND platform = $2", [req.user.id, bot.platform]
    );
    const run = rows[0] || null;
    const activity = run && run.instance_id ? runner.getActivity(run.instance_id) : [];
    if (run) delete run.instance_id;
    res.json({
      run,
      live: process.env.LIVE_TRADING === "true", // false = dry run, no real orders
      activity,
      license: await checkLicense(bot.id),
      // the app adds its own "Internet" check on the phone
      checks: {
        account: acct.rows.length > 0,
        symbols: bot.symbols.length > 0,
        active: run ? run.status === "running" : false,
      },
    });
  }));

  // After a server restart, bring back every run still marked running; mark half-started ones failed.
  setTimeout(async () => {
    try {
      await db.query("UPDATE bot_runs SET status = 'failed', stopped_at = now() WHERE status IN ('starting', 'stopping')");
      const { rows } = await db.query(
        `SELECT r.id, r.instance_id, r.settings FROM bot_runs r WHERE r.status = 'running' AND r.instance_id IS NOT NULL`
      );
      for (const r of rows) {
        try { await runner.resumeInstance({ instanceId: r.instance_id, settings: r.settings }); console.log("Resumed run", r.id); }
        catch (e) { console.error("Could not resume run", r.id, e.message); }
      }
    } catch (e) {
      console.error("Resume failed", e.message);
    }
  }, 5000);

  // Every minute: stop running bots whose key was revoked or has expired
  setInterval(async () => {
    try {
      const { rows } = await db.query(
        `SELECT r.user_bot_id FROM bot_runs r
         JOIN user_bots ub ON ub.id = r.user_bot_id
         LEFT JOIN license_keys k ON k.id = ub.key_id
         WHERE r.status = 'running'
           AND (k.id IS NULL OR k.status = 'revoked'
                OR (k.expires_at IS NOT NULL AND k.expires_at <= now()))`
      );
      // leave_open: don't close a user's trades just because their license lapsed
      for (const r of rows) await stopRun(r.user_bot_id, "leave_open", "license_invalid");
    } catch (e) {
      console.error("License sweep failed", e.message);
    }
  }, 60 * 1000);
}

module.exports = { registerRunRoutes };
