// Allows the GitHub Pages app to call this server from a different domain.
// Without this, browsers block the requests by default (CORS).
function corsMiddleware(req, res, next) {
  const allowed = (process.env.ALLOWED_ORIGIN || "").split(",").map((s) => s.trim()).filter(Boolean);
  const origin = req.header("origin");
  if (origin && allowed.includes(origin)) res.header("Access-Control-Allow-Origin", origin);
  res.header("Access-Control-Allow-Headers", "Content-Type, Authorization, x-admin-token");
  res.header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
}
module.exports = { corsMiddleware };
