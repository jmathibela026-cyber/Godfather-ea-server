// Runner: starts and stops one isolated terminal instance per bot.
// This is a stub. Swap the bodies for your real hosting (Docker, VM, Windows VPS...).
//
// Isolation rules for user-uploaded EAs (they are untrusted code):
//  - one container/VM per run, never shared between users
//  - network limited to the broker's servers (and your license server if needed)
//  - CPU/RAM limits, read-only filesystem except the terminal's data folder
//  - destroy the instance completely on stop

async function startInstance({ botId, filePath, settings, account }) {
  // account = { platform: "mt4" | "mt5", login, server, password }
  // 1. Start a container with the right terminal (account.platform) installed
  // 2. Copy filePath (.ex4/.ex5) into its Experts folder
  // 3. Write `settings` as the EA's inputs (.set file) or startup config
  // 4. Log in with account.login / account.server / account.password
  //    (pass via env/stdin, never write to disk or logs)
  // 5. Attach the EA to a chart for each of settings.symbols ({ symbol, lot, action }).
  //    Pass lot and action (BUY / SELL / BOTH) as EA inputs; the bot's own strategy
  //    decides when to enter. Uploaded EAs must expose inputs for lot and direction.
  return "instance-" + botId + "-" + Date.now(); // return the real instance id
}

async function stopInstance({ instanceId, mode }) {
  // mode === "close_all"  -> close every open trade, confirm they closed, then shut down
  // mode === "leave_open" -> just shut down; open trades stay with the broker, unmanaged
  // Then destroy the container/VM.
}

module.exports = { startInstance, stopInstance };
