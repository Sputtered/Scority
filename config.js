export default {
  listenPort: 25566,
  listenHost: "127.0.0.1",

  targetHost: "mc.hypixel.net",
  targetPort: 25565,

  // must match the client version
  protocolVersion: "1.8.9",

  // account cache key
  mojangUsername: process.env.MINECRAFT_USERNAME || (process.env.MINECRAFT_ACCOUNTS || "").split(",")[0].trim(),

  authCacheDir: "./mc-auth-cache",

  teamColors: {
    red: ["red", "dark_red"],
    blue: ["blue", "dark_blue"],
    green: ["green", "dark_green"],
    yellow: ["yellow", "gold"],
    aqua: ["aqua", "dark_aqua"],
    white: ["white"],
    pink: ["light_purple", "dark_purple", "pink"],
    grey: ["gray", "dark_gray", "grey"],
  },

  outputDir: "./output",

  // standalone proxy only; credentials from environment
  pipeline: {
    uploadUrl: process.env.REPLAY_PIPELINE_UPLOAD_URL || "",
    apiKey: process.env.REPLAY_PIPELINE_API_KEY || "",

    autoQueue: process.env.REPLAY_PIPELINE_AUTO_QUEUE === "1",

    pollIntervalMs: Number(process.env.REPLAY_PIPELINE_POLL_INTERVAL_MS || 45_000),

    pendingReplaysUrl:
      process.env.REPLAY_PIPELINE_PENDING_URL ||
      (process.env.REPLAY_PIPELINE_UPLOAD_URL || "").replace(
        /\/api\/pipeline\/import-replay\/?$/,
        "/api/pipeline/pending-replays",
      ),
  },

  onlyRecordWhilePlaying: true,

  // automated input; check server rules
  automation: {
    enabled: true,

    postSpawnDelayMs: 5000,

    postCommandDelayMs: 10000,

    postLobbyDelayMs: 5000,

    // zero-based hotbar slot
    menuSlot: 6,
    replaySpeed: 4,
    rightClickCount: 0,
    rightClickIntervalMs: 750,

    // zero-based hotbar slot
    speedSlot: 4,
    speedSlotClickCount: 0,

    betweenReplaysDelayMs: 3000,

    // zero disables movement
    movementIntervalMs: 4 * 60 * 1000,
    movementHoldMs: 1000,
  },
};
