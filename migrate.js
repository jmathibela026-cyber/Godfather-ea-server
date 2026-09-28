// Runs schema_final.sql against the database every time the server starts.
// Safe to run repeatedly: every statement uses IF NOT EXISTS, so it does
// nothing on a database that's already set up.
const fs = require("fs");
const path = require("path");

async function migrate(db) {
  const sql = fs.readFileSync(path.join(__dirname, "schema_final.sql"), "utf8");
  await db.query(sql);
  console.log("Database schema is up to date");
}

module.exports = { migrate };
