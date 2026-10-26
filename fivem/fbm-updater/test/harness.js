"use strict";
/**
 * Harnais de test : simule l'environnement serveur FiveM (natives, commande, chat, redémarrage)
 * et charge la ressource telle quelle (server/engine.js puis server/main.js).
 *
 * En module : const r = load({ dir, convars }); await r.cmd(0, ["update"]); r.restart();
 * En ligne de commande (e2e) : node test/harness.js --dir D --api URL --token T boot | cmd <args…>
 */
const path = require("path");

const ENGINE = path.join(__dirname, "..", "server", "engine.js");
const MAIN = path.join(__dirname, "..", "server", "main.js");
const realSetTimeout = global.setTimeout;
const realSetInterval = global.setInterval;

function load(opts) {
  const st = {
    logs: [],
    chat: [],
    commands: {},
    events: {},
    convars: Object.assign({ fbm_check_interval: "0" }, opts.convars || {}),
    resourceStates: opts.resourceStates || {},
    aces: opts.aces || {},
  };

  function boot() {
    Object.assign(global, {
      GetCurrentResourceName: () => "fbm-updater",
      GetResourcePath: () => path.join(opts.dir, "resources", "[fbm]", "fbm-updater"),
      GetConvar: (k, d) => (st.convars[k] !== undefined ? String(st.convars[k]) : d),
      GetConvarInt: (k, d) => (st.convars[k] !== undefined ? parseInt(st.convars[k], 10) : d),
      GetResourceState: (n) => st.resourceStates[n] || "missing",
      GetPlayerName: (s) => `joueur${s}`,
      IsPlayerAceAllowed: (s, ace) => !!(st.aces[s] || []).includes(ace),
      getPlayers: () => Object.keys(st.aces),
      emitNet: (ev, target, payload) => st.chat.push({ ev, target, text: payload.args[1] }),
      RegisterCommand: (name, fn, restricted) => (st.commands[name] = { fn, restricted }),
      on: (ev, fn) => (st.events[ev] = fn),
      source: 0,
      // les minuteries longues (vérification périodique) ne sont pas lancées pendant les tests
      setTimeout: (fn, ms, ...a) => (ms >= 10000 ? 0 : realSetTimeout(fn, ms, ...a)),
      setInterval: (fn, ms, ...a) => (ms >= 10000 ? 0 : realSetInterval(fn, ms, ...a)),
    });
    const origLog = console.log;
    console.log = (...a) => st.logs.push(a.join(" ").replace(/\^\d/g, ""));
    try {
      delete require.cache[ENGINE];
      delete require.cache[MAIN];
      require(ENGINE);
      require(MAIN); // exécute boot() : applique une éventuelle mise à jour préparée
    } finally {
      console.log = origLog;
    }
  }

  boot();
  return {
    st,
    /** Simule un redémarrage du serveur (la ressource est rechargée). */
    restart() {
      st.logs.length = 0;
      st.chat.length = 0;
      boot();
    },
    async cmd(src, args) {
      const origLog = console.log;
      console.log = (...a) => st.logs.push(a.join(" ").replace(/\^\d/g, ""));
      try {
        await st.commands.fbm.fn(src, args, `fbm ${args.join(" ")}`);
      } finally {
        console.log = origLog;
      }
    },
    text() {
      return st.logs.join("\n");
    },
  };
}

module.exports = { load };

if (require.main === module) {
  const argv = process.argv.slice(2);
  const get = (k) => {
    const i = argv.indexOf(k);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const dir = get("--dir");
  const convars = { fbm_api: get("--api"), fbm_token: get("--token") };
  if (get("--channel")) convars.fbm_channel = get("--channel");
  const action = argv[argv.indexOf("--token") + 2];
  const rest = argv.slice(argv.indexOf("--token") + 3);
  (async () => {
    const r = load({ dir, convars });
    if (action === "cmd") await r.cmd(0, rest);
    process.stdout.write(r.text() + "\n");
  })().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
