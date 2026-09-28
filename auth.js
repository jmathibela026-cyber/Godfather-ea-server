// Auth: login with Mentor ID + email (no password, no email code).
const crypto = require("crypto");

const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const SESSION_DAYS = 30;

function sha(value) {
  return crypto.createHmac("sha256", process.env.KEY_SECRET).update(value).digest("hex");
}

// Long random Mentor ID, e.g. MN-7K3M-Q9XP-2WDL-H4TC (~80 bits, not guessable)
function generateMentorId() {
  const bytes = crypto.randomBytes(16);
  let raw = "";
  for (let i = 0; i < 16; i++) raw += ALPHABET[bytes[i] % ALPHABET.length];
  return "MN-" + raw.match(/.{4}/g).join("-");
}

// Simple in-memory limiter: 10 login attempts per IP per 15 minutes.
// (Use Redis or your host's limiter if you run more than one server.)
const attempts = new Map();
function tooManyAttempts(ip) {
  const now = Date.now();
  const a = attempts.get(ip);
  if (!a || a.resetAt < now) { attempts.set(ip, { count: 1, resetAt: now + 15 * 60 * 1000 }); return false; }
  a.count += 1;
  return a.count > 10;
}

function makeAuth(db) {
  // Replaces the old placeholder: reads "Authorization: Bearer <token>"
  async function requireUser(req, res, next) {
    try {
      const h = req.header("authorization") || "";
      const token = h.startsWith("Bearer ") ? h.slice(7) : "";
      if (!token) return res.status(401).json({ error: "Not signed in" });
      const { rows } = await db.query(
        `SELECT s.user_id FROM sessions s JOIN users u ON u.id = s.user_id
         WHERE s.token_hash = $1 AND s.expires_at > now() AND u.disabled_at IS NULL`,
        [sha(token)]
      );
      if (!rows[0]) return res.status(401).json({ error: "Not signed in" });
      req.user = { id: rows[0].user_id };
      next();
    } catch (e) { next(e); }
  }

  function registerRoutes(app, { requireAdmin }) {
    // POST /auth/login { mentorId, email } -> { token }
    app.post("/auth/login", async (req, res, next) => {
      try {
        if (tooManyAttempts(req.ip)) return res.status(429).json({ error: "Too many attempts. Try again later." });

        const mentorId = String(req.body.mentorId || "").trim().toUpperCase();
        const email = String(req.body.email || "").trim().toLowerCase();
        const { rows } = await db.query(
          "SELECT id FROM users WHERE mentor_hash = $1 AND email = $2 AND disabled_at IS NULL",
          [sha(mentorId), email]
        );
        // One message for every failure: never reveal whether the ID or the email was wrong
        if (!rows[0]) return res.status(401).json({ error: "Mentor ID or email is incorrect" });

        const token = crypto.randomBytes(32).toString("hex");
        await db.query(
          "INSERT INTO sessions (token_hash, user_id, expires_at) VALUES ($1, $2, now() + ($3::int * interval '1 day'))",
          [sha(token), rows[0].id, SESSION_DAYS]
        );
        res.json({ token });
      } catch (e) { next(e); }
    });

    // POST /auth/logout
    app.post("/auth/logout", requireUser, async (req, res, next) => {
      try {
        const token = (req.header("authorization") || "").slice(7);
        await db.query("DELETE FROM sessions WHERE token_hash = $1", [sha(token)]);
        res.json({ loggedOut: true });
      } catch (e) { next(e); }
    });

    // POST /admin/users { email } -> creates a user and returns their Mentor ID ONCE
    app.post("/admin/users", requireAdmin, async (req, res, next) => {
      try {
        const email = String(req.body.email || "").trim().toLowerCase();
        if (!/^\S+@\S+\.\S+$/.test(email)) return res.status(400).json({ error: "Valid email required" });
        const mentorId = generateMentorId();
        const { rows } = await db.query(
          "INSERT INTO users (mentor_hash, email) VALUES ($1, $2) RETURNING id",
          [sha(mentorId), email]
        );
        res.json({ userId: rows[0].id, mentorId });
      } catch (e) { next(e); }
    });

    // POST /admin/users/disable { userId } -> blocks login and kills their sessions
    app.post("/admin/users/disable", requireAdmin, async (req, res, next) => {
      try {
        await db.query("UPDATE users SET disabled_at = now() WHERE id = $1", [req.body.userId]);
        await db.query("DELETE FROM sessions WHERE user_id = $1", [req.body.userId]);
        res.json({ disabled: true });
      } catch (e) { next(e); }
    });
  }

  return { requireUser, registerRoutes };
}

module.exports = { makeAuth };
