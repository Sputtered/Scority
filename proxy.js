import fs from "node:fs";
import path from "node:path";
import mc from "minecraft-protocol";
import config from "./config.js";
import { discordRuntime } from "./lib/discord/runtime.js";
import {headlessPeer,attachHeadlessViewer} from './lib/headless-viewer.js';
import { parseMessage } from "./lib/death-parser.js";
import { parseActionBar } from "./lib/actionbar-parser.js";
import { relayPlayPacket } from "./lib/relay.js";
import { Match } from "./lib/match.js";
import { promptReplayQueue, fetchApprovedReplayQueue, startAutoQueuePolling, ReplayAutomator } from "./lib/bot-orchestrator.js";

const DEBUG = process.env.DEBUG_PACKETS === "1";
const PREVIEW_LEN = Number(process.env.DEBUG_PACKET_PREVIEW_LEN || 800);
const RING_SIZE = 40;
const SAMPLE_LIMIT = 5;

const PIPELINE_ENABLED = !discordRuntime && Boolean(config.pipeline?.uploadUrl && config.pipeline?.apiKey);
if (discordRuntime) {
  console.log("Discord mode: local queue and game library; website integration disabled.");
} else if (PIPELINE_ENABLED) {
  console.log(`Pipeline auto-upload is ON, every saved replay will also be POSTed to ${config.pipeline.uploadUrl}`);
} else {
  console.log("Pipeline auto-upload is OFF (set REPLAY_PIPELINE_UPLOAD_URL and REPLAY_PIPELINE_API_KEY to enable), replays will only be saved locally under outputDir.");
}

async function uploadToPipeline(json, label) {
  if (!PIPELINE_ENABLED) return;
  try {
    const res = await fetch(config.pipeline.uploadUrl, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": config.pipeline.apiKey },
      body: JSON.stringify(json),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      console.error(`[pipeline] upload for ${label} failed: ${res.status} ${body.slice(0, 300)}`);
      return;
    }
    const data = await res.json().catch(() => null);
    console.log(`[pipeline] uploaded ${label} -> submission #${data?.submissionId ?? "?"} (pending admin review in the Manager > Replays tab)`);
  } catch (err) {
    console.error(`[pipeline] upload for ${label} threw: ${err.message}`);
  }
}

fs.mkdirSync(config.outputDir, { recursive: true });
fs.mkdirSync(config.authCacheDir, { recursive: true });

if (!config.mojangUsername || config.mojangUsername === "your-email-or-username-here") {
  console.error("Set mojangUsername in config.js to your Microsoft account email (or Minecraft username) before running this.");
  process.exit(1);
}

const automationEnabled = Boolean(discordRuntime || config.automation?.enabled);
const autoQueueEnabled = !discordRuntime && automationEnabled && Boolean(config.pipeline?.autoQueue);
let replayQueue = [];
let sessionOutputDir = config.outputDir;
if (automationEnabled) {
  replayQueue = discordRuntime ? [] : autoQueueEnabled
    ? await fetchApprovedReplayQueue(config.pipeline, console.log)
    : await promptReplayQueue();
  sessionOutputDir = path.join(config.outputDir, `session-${Date.now()}`);
  fs.mkdirSync(sessionOutputDir, { recursive: true });
  if (discordRuntime) {
    console.log("Discord queue ready · submit with /submit. No website or terminal queue required.");
  } else if (replayQueue.length === 0) {
    console.log(
      autoQueueEnabled
        ? "No approved replays pending right now, automation will idle once a client connects and pick up anything approved via the next poll."
        : "No replays entered, automation will idle once a client connects. Ctrl+C to quit, or restart and enter at least one.",
    );
  } else if (autoQueueEnabled) {
    console.log(`auto-queue: pulled ${replayQueue.length} approved replay(s) from the admin panel: ${replayQueue.join(", ")}`);
  }
}

const debugLogPath = path.join(config.outputDir, "debug-packets.log");
function debugLog(line) {
  if (!DEBUG) return;
  try {
    fs.appendFileSync(debugLogPath, line + "\n");
  } catch (err) {
    console.error("[debugLog] failed to write debug-packets.log:", err.message);
  }
}

// flush crash evidence synchronously
const crashLogPath = path.join(config.outputDir, "crash.log");
function logFatal(label, err) {
  const line = `[${new Date().toISOString()}] ${label}: ${err && err.stack ? err.stack : err}\n`;
  console.error(line);
  try {
    fs.appendFileSync(crashLogPath, line);
  } catch {
  }
}

process.on("uncaughtException", (err) => {
  logFatal("uncaughtException", err);
  // keep running after logging
});
process.on("unhandledRejection", (reason) => {
  logFatal("unhandledRejection", reason);
});

function hexPreview(buffer, maxBytes = 32) {
  if (!buffer || !Buffer.isBuffer(buffer)) return null;
  return buffer.subarray(0, maxBytes).toString("hex");
}

function jsonPreview(data) {
  try {
    const s = JSON.stringify(data);
    if (PREVIEW_LEN > 0 && s.length > PREVIEW_LEN) return s.slice(0, PREVIEW_LEN) + `...[+${s.length - PREVIEW_LEN} chars]`;
    return s;
  } catch (err) {
    return `<unstringifiable: ${err.message}>`;
  }
}

const CHAT_PACKET_NAMES = new Set(["chat", "system_chat", "player_chat"]);
const TAB_LIST_PACKET_NAMES = new Set(["player_list_item", "player_info", "player_info_update"]);
const TAB_LIST_REMOVE_PACKET_NAMES = new Set(["player_info_remove"]);

function isActionBarPosition(data) {
  if (typeof data.position === "number") return data.position === 2;
  if (typeof data.overlay === "boolean") return data.overlay === true;
  return false;
}

function extractChatComponent(data) {
  const raw = data.message ?? data.content ?? data.chatContent;
  if (raw == null) return null;
  if (typeof raw === "string") {
    try {
      return JSON.parse(raw);
    } catch {
      return raw;
    }
  }
  return raw;
}

function stripFormatting(name) {
  if (typeof name !== "string") return name;
  let out = name.replace(/\u00a7./g, "");
  // remove truncated formatting codes
  out = out.replace(/\u00a7.?$/, "");
  return out;
}

function extractTabListNames(meta, data, sessionDebug) {
  const added = [];
  try {
    if ((meta.name === "player_list_item" || meta.name === "player_info") && Array.isArray(data.data)) {
      for (const entry of data.data) {
        const name = entry.name || entry.player?.name;
        if (name) added.push(stripFormatting(name));
      }
    } else if (meta.name === "player_info_update" && Array.isArray(data.data)) {
      for (const entry of data.data) {
        const name = entry.player?.name || entry.name;
        if (name) added.push(stripFormatting(name));
      }
    } else {
      sessionDebug.tabListShapeMismatches.push({
        packetName: meta.name,
        preview: jsonPreview(data),
      });
    }
  } catch (err) {
    debugLog(`[tab-list parse error] ${err.message}`);
    sessionDebug.errors.push({ where: "extractTabListNames", packetName: meta.name, message: err.message, stack: err.stack });
  }
  return added;
}

function makeRing(size) {
  const buf = [];
  return {
    push(entry) {
      buf.push(entry);
      if (buf.length > size) buf.shift();
    },
    toArray() {
      return buf.slice();
    },
  };
}

let matchCounter = 0;

function startProxySession(clientConn, runtime=discordRuntime, account=null) {
  const discordRuntime=runtime;
  matchCounter += 1;
  const sessionId = matchCounter;
  const sessionStartedAt = Date.now();
  console.log(`[session ${sessionId}] client connected, dialing Hypixel...`);

  function newMatch(meta = {}) {
    return new Match({
      teamColors: config.teamColors,
      onlyRecordWhilePlaying: config.onlyRecordWhilePlaying,
      protocolVersion: config.protocolVersion,
      meta: { source: "hypixel-replay", capturedAt: new Date().toISOString(), ...meta },
    });
  }

  let match = newMatch();
  let replaysSavedThisSession = 0;

  let tabListEverParsed = false;
  let actionBarEverParsed = false;
  let lastLoggedActionBarState = null;
  let chatPacketEverSeen = false;
  let saved = false;
  let clientSpawned = false;

  // relay only after both handshakes finish
  let hypixelReady = false;

  const sessionDebug = {
    sessionId,
    startedAt: new Date(sessionStartedAt).toISOString(),
    packetCounts: { "client->hypixel": {}, "hypixel->client": {} },
    ring: { "client->hypixel": makeRing(RING_SIZE), "hypixel->client": makeRing(RING_SIZE) },
    chatSamples: [],
    tabListSamples: [],
    tabListShapeMismatches: [],
    actionBarNonMatchSamples: [],
    stateTransitions: [],
    relayErrors: [],
    errors: [],
    endEvents: [],
  };

  function countPacket(direction, name) {
    const counts = sessionDebug.packetCounts[direction];
    counts[name] = (counts[name] || 0) + 1;
  }

  const hypixelClient = mc.createClient({
    host: config.targetHost,
    port: config.targetPort,
    version: config.protocolVersion,
    auth: "microsoft",
    username: account?.username || config.mojangUsername,
    profilesFolder: account?.authCacheDir || config.authCacheDir,
  });
  // reject late transports after finalization
  const setSocket=hypixelClient.setSocket.bind(hypixelClient);
  hypixelClient.setSocket=socket=>{
    if(saved){socket.on('error',()=>{});socket.destroy();return;}
    return setSocket(socket);
  };
  const stopHeadlessViewer=clientConn.managed
    ? attachHeadlessViewer(hypixelClient,{viewDistance:discordRuntime.control.values['client.viewDistance']})
    : ()=>{};

  clientConn.on("state", (newState, oldState) => {
    const line = `[session ${sessionId}] clientConn state: ${oldState} -> ${newState}`;
    console.log(line);
    sessionDebug.stateTransitions.push({ side: "clientConn", from: oldState, to: newState, t: Date.now() - sessionStartedAt });
  });
  hypixelClient.on("state", (newState, oldState) => {
    const line = `[session ${sessionId}] hypixelClient state: ${oldState} -> ${newState}`;
    console.log(line);
    sessionDebug.stateTransitions.push({ side: "hypixelClient", from: oldState, to: newState, t: Date.now() - sessionStartedAt });
  });
  hypixelClient.on("connect", () => {
    if(saved){hypixelClient.end('Session already closed');hypixelClient.socket?.destroy();return;}
    console.log(`[session ${sessionId}] TCP connected to Hypixel, starting login...`);
  });
  hypixelClient.on("login", () => {
    if(saved){hypixelClient.end('Session already closed');hypixelClient.socket?.destroy();return;}
    console.log(`[session ${sessionId}] Hypixel login complete, now in play state`);
    hypixelReady = true;
    if(account)account.label=hypixelClient.username;
  });

  const automator = automationEnabled
    ? new ReplayAutomator({
        hypixelClient,
        automationConfig: {...config.automation},
        log: (line) => console.log(`[session ${sessionId}] ${line}`),
        onReplayStarting: (replayId, submissionId) => {
          if(discordRuntime?.control)automator.cfg={...config.automation};
          if (discordRuntime) {
            match = newMatch({replayId, discordSubmissionId: submissionId});
            tabListEverParsed = false;
            actionBarEverParsed = false;
            lastLoggedActionBarState = null;
            return;
          }
          console.log(`[session ${sessionId}] automation: tagging upcoming match with replayId=${replayId} (site submissionId=${submissionId})`);
          match.meta.replayId = replayId;
          match.meta.pipelineSubmissionId = submissionId;
        },
        onReplayFinished: async () => {
          replaysSavedThisSession += 1;
          console.log(`[session ${sessionId}] onReplayFinished: building export for replay #${replaysSavedThisSession} of this session (replayId=${match.meta.replayId ?? "n/a"})`);
          const json = match.toJSON();
          json.match.endReason = "replay_finished";
          if (discordRuntime && !discordRuntime.recorder.complete(json)) {
            match = newMatch();
            tabListEverParsed = false;
            actionBarEverParsed = false;
            lastLoggedActionBarState = null;
            return;
          }
          const filename = `replay-${sessionId}-${replaysSavedThisSession}-${Date.now()}.json`;
          const outPath = path.join(sessionOutputDir, filename);
          console.log(`[session ${sessionId}] writing ${outPath} (${json.killFeed.length} kill-feed events, ${json.bedBreaks.length} bed breaks, ${Object.keys(json.players).length} players)`);
          fs.writeFileSync(outPath, JSON.stringify(json, null, 2));
          console.log(`[session ${sessionId}] saved ${outPath}`);
          if (json.warnings.length) {
            console.log(`[session ${sessionId}] warnings:`);
            json.warnings.forEach((w) => console.log(`  - ${w}`));
          }
          if (PIPELINE_ENABLED) console.log(`[session ${sessionId}] onReplayFinished: uploading to pipeline...`);
          // reset before upload to prevent duplicate saves
          match = newMatch();
          tabListEverParsed = false;
          actionBarEverParsed = false;
          lastLoggedActionBarState = null;
          await uploadToPipeline(json, filename);
        },
      })
    : null;
  if (discordRuntime) {
    discordRuntime.recorder.attach(automator);
  } else if (automationEnabled) {
    // preserve the queue across reconnects
    automator.setQueue(replayQueue, { shared: true });
  }

  const autoQueuePollTimer = autoQueueEnabled
    ? startAutoQueuePolling(automator, config.pipeline, (line) => console.log(`[session ${sessionId}] ${line}`))
    : null;

  function tap(meta, data, direction) {
    debugLog(`[${direction}] ${meta.name}: ${jsonPreview(data)}`);
    if (discordRuntime && !discordRuntime.recorder.activeJob) return;
    // update world state before chat filters
    match.observePacket(meta.name, data, meta.state || 'play');

    if (TAB_LIST_PACKET_NAMES.has(meta.name)) {
      if (sessionDebug.tabListSamples.length < SAMPLE_LIMIT) {
        sessionDebug.tabListSamples.push({ packetName: meta.name, preview: jsonPreview(data) });
      }
      const names = extractTabListNames(meta, data, sessionDebug);
      if (names.length) {
        if (!tabListEverParsed) console.log(`[session ${sessionId}] first tab-list names parsed OK (${meta.name}): ${names.slice(0, 5).join(", ")}${names.length > 5 ? ", ..." : ""}`);
        tabListEverParsed = true;
        names.forEach((n) => match.addOnlinePlayer(n));
      }
      return;
    }

    if (!CHAT_PACKET_NAMES.has(meta.name)) return;

    chatPacketEverSeen = true;
    const component = extractChatComponent(data);
    if (component == null) {
      if (sessionDebug.chatSamples.length < SAMPLE_LIMIT) {
        sessionDebug.chatSamples.push({ packetName: meta.name, preview: jsonPreview(data), note: "extractChatComponent returned null, check field name (message/content/chatContent)" });
      }
      return;
    }

    if (sessionDebug.chatSamples.length < SAMPLE_LIMIT) {
      sessionDebug.chatSamples.push({ packetName: meta.name, preview: jsonPreview(data) });
    }

    if (isActionBarPosition(data)) {
      let parsed;
      try {
        parsed = parseActionBar(component);
      } catch (err) {
        sessionDebug.errors.push({ where: "parseActionBar", message: err.message, stack: err.stack, dataPreview: jsonPreview(data) });
        debugLog(`[parseActionBar error] ${err.message}`);
        return;
      }
      if (parsed) {
        if (!actionBarEverParsed) console.log(`[session ${sessionId}] first action-bar HUD parsed OK: state=${parsed.state} ${parsed.elapsedSec}/${parsed.totalSec}s speed=${parsed.speed}x`);
        actionBarEverParsed = true;
        if (parsed.state !== lastLoggedActionBarState) {
          console.log(`[session ${sessionId}] action-bar state: ${lastLoggedActionBarState ?? "(none)"} -> ${parsed.state} (${parsed.elapsedSec}/${parsed.totalSec}s, speed=${parsed.speed}x)`);
          lastLoggedActionBarState = parsed.state;
        }
        if (discordRuntime && !discordRuntime.recorder.progress(parsed)) {
          match = newMatch();
          tabListEverParsed = false;
          actionBarEverParsed = false;
          lastLoggedActionBarState = null;
          return;
        }
        match.updateActionBar(parsed);
        if (automator && (!discordRuntime || discordRuntime.recorder.seenReplay)) automator.onActionBar(parsed);
      } else if (sessionDebug.actionBarNonMatchSamples.length < SAMPLE_LIMIT) {
        sessionDebug.actionBarNonMatchSamples.push({ preview: jsonPreview(data) });
      }
      return;
    }

    if (discordRuntime && meta.name !== 'player_chat') {
      void discordRuntime.recorder.onChat(component).catch(err =>
        console.error(`[discord] Could not handle replay notice: ${err.message}`));
    }

    let event;
    try {
      const knownPlayers = tabListEverParsed ? match.knownOnlinePlayers : null; // null trusts all names
      event = parseMessage(component, knownPlayers, match.resolveTeam);
    } catch (err) {
      sessionDebug.errors.push({ where: "parseMessage", message: err.message, stack: err.stack, dataPreview: jsonPreview(data) });
      debugLog(`[parseMessage error] ${err.message}`);
      return;
    }
    if (event) {
      if (event.type === "death") {
        console.log(
          `[session ${sessionId}] event: death, victim=${event.victim} killer=${event.killer ?? "(environmental)"} cause=${event.cause}${event.finalKill ? " FINAL KILL" : ""} :: "${event.raw}"`,
        );
      } else if (event.type === "bed_break") {
        console.log(`[session ${sessionId}] event: bed_break, team=${event.team} breaker=${event.breaker} :: "${event.raw}"`);
      } else {
        console.log(`[session ${sessionId}] event: ${event.type} :: "${event.raw}"`);
      }
      try {
        match.handleParsedMessage(event);
      } catch (err) {
        sessionDebug.errors.push({ where: "match.handleParsedMessage", message: err.message, stack: err.stack, event });
        debugLog(`[handleParsedMessage error] ${err.message}`);
      }
    }
  }

  // raw buffers avoid reserialization
  clientConn.on("packet", (data, meta, buffer) => {
    if(saved)return;
    countPacket("client->hypixel", meta.name);
    sessionDebug.ring["client->hypixel"].push({
      t: Date.now() - sessionStartedAt,
      name: meta.name,
      state: meta.state,
      size: buffer ? buffer.length : null,
      hex: hexPreview(buffer),
    });
    if (!hypixelReady) {
      return;
    }
    try {
      relayPlayPacket(clientConn, hypixelClient, data, meta, buffer);
    } catch (err) {
      const detail = {
        direction: "client->hypixel",
        packetName: meta.name,
        state: meta.state,
        bufferLength: buffer ? buffer.length : null,
        hexPreview: hexPreview(buffer, 64),
        message: err.message,
        stack: err.stack,
      };
      sessionDebug.relayErrors.push(detail);
      console.error(`[session ${sessionId}] relay client->hypixel error on packet "${meta.name}" (state=${meta.state}, ${detail.bufferLength} bytes):`, err.message);
      debugLog(`[relay client->hypixel error] ${meta.name}: ${err.message}\n${err.stack}`);
    }
  });

  hypixelClient.on("packet", (data, meta, buffer) => {
    if(saved)return;
    countPacket("hypixel->client", meta.name);
    sessionDebug.ring["hypixel->client"].push({
      t: Date.now() - sessionStartedAt,
      name: meta.name,
      state: meta.state,
      size: buffer ? buffer.length : null,
      hex: hexPreview(buffer),
    });
    if (automator && meta.name === "position") {
      automator.trackPosition(data);
      if (!clientSpawned) {
        clientSpawned = true;
        if (discordRuntime) discordRuntime.recorder.spawned();
        automator.onClientSpawned().catch((err) => {
          console.error(`[session ${sessionId}] automation error:`, err.message);
          sessionDebug.errors.push({ where: "automator.onClientSpawned", message: err.message, stack: err.stack });
        });
      }
    }
    try {
      tap(meta, data, "hypixel->client");
    } catch (err) {
      sessionDebug.errors.push({ where: "tap", packetName: meta.name, message: err.message, stack: err.stack });
      debugLog(`[tap error] ${meta.name}: ${err.message}\n${err.stack}`);
    }
    if (meta.state !== "play") {
      return;
    }
    try {
      relayPlayPacket(hypixelClient, clientConn, data, meta, buffer);
    } catch (err) {
      const detail = {
        direction: "hypixel->client",
        packetName: meta.name,
        state: meta.state,
        bufferLength: buffer ? buffer.length : null,
        hexPreview: hexPreview(buffer, 64),
        message: err.message,
        stack: err.stack,
      };
      sessionDebug.relayErrors.push(detail);
      console.error(`[session ${sessionId}] relay hypixel->client error on packet "${meta.name}" (state=${meta.state}, ${detail.bufferLength} bytes):`, err.message);
      debugLog(`[relay hypixel->client error] ${meta.name}: ${err.message}\n${err.stack}`);
    }
  });

  function writeSessionDebugFile(reason) {
    const filename = `session-${sessionStartedAt}-${sessionId}-debug.json`;
    const outPath = path.join(config.outputDir, filename);
    const payload = {
      sessionId,
      startedAt: sessionDebug.startedAt,
      endedAt: new Date().toISOString(),
      durationMs: Date.now() - sessionStartedAt,
      endReason: reason,
      endEvents: sessionDebug.endEvents,
      tabListEverParsed,
      actionBarEverParsed,
      chatPacketEverSeen,
      packetCounts: sessionDebug.packetCounts,
      recentPackets: {
        "client->hypixel": sessionDebug.ring["client->hypixel"].toArray(),
        "hypixel->client": sessionDebug.ring["hypixel->client"].toArray(),
      },
      chatSamples: sessionDebug.chatSamples,
      tabListSamples: sessionDebug.tabListSamples,
      tabListShapeMismatches: sessionDebug.tabListShapeMismatches,
      actionBarNonMatchSamples: sessionDebug.actionBarNonMatchSamples,
      stateTransitions: sessionDebug.stateTransitions,
      relayErrors: sessionDebug.relayErrors,
      errors: sessionDebug.errors,
    };
    try {
      fs.writeFileSync(outPath, JSON.stringify(payload, null, 2));
      console.log(`[session ${sessionId}] wrote debug summary ${outPath}`);
    } catch (err) {
      console.error(`[session ${sessionId}] failed to write debug summary:`, err.message);
    }
  }

  function finalizeAndSave(reason) {
    // auth failures may never emit end
    stopHeadlessViewer();
    if (discordRuntime && !saved) discordRuntime.recorder.detach(reason);
    if (automator) automator.stop();
    if (autoQueuePollTimer) clearInterval(autoQueuePollTimer);
    sessionDebug.endEvents.push({ reason, t: Date.now() - sessionStartedAt });

    // both sockets can trigger finalization
    if (saved) {
      console.log(`[session ${sessionId}] finalizeAndSave("${reason}") skipped, already saved for this session (see endEvents in the debug summary for all end triggers).`);
      return;
    }
    if (!hypixelReady) {
      saved = true;
      console.log(`[session ${sessionId}] ended before Hypixel login completed (reason=${reason}), not saving a replay file, nothing was recorded yet.`);
      writeSessionDebugFile(reason);
      return;
    }

    saved = true;

    if (match.killFeed.length === 0 && match.bedBreakLog.length === 0) {
      writeSessionDebugFile(reason);
      return;
    }
    const json = match.toJSON();
    json.match.endReason = reason;
    const filename = `replay-${sessionId}-${Date.now()}.json`;
    const outPath = path.join(sessionOutputDir, filename);
    fs.writeFileSync(outPath, JSON.stringify(json, null, 2));
    console.log(`[session ${sessionId}] saved ${outPath} (lasted ${Date.now() - sessionStartedAt}ms, reason=${reason})`);
    if (json.warnings.length) {
      console.log(`[session ${sessionId}] warnings:`);
      json.warnings.forEach((w) => console.log(`  - ${w}`));
    }
    uploadToPipeline(json, filename);

    console.log(
      `[session ${sessionId}] packet totals: client->hypixel=${Object.values(sessionDebug.packetCounts["client->hypixel"]).reduce((a, b) => a + b, 0)}, ` +
        `hypixel->client=${Object.values(sessionDebug.packetCounts["hypixel->client"]).reduce((a, b) => a + b, 0)}`,
    );

    if (!chatPacketEverSeen) {
      console.log(
        `[session ${sessionId}] WARNING: never saw a single packet named one of [${[...CHAT_PACKET_NAMES].join(", ")}] from Hypixel this session. ` +
          `Either the session ended before any chat arrived, or minecraft-protocol names this packet something else for this version, ` +
          `run with DEBUG_PACKETS=1 and/or check the "hypixel->client" packetCounts in the session debug file to see what actually came through.`,
      );
    }
    if (!tabListEverParsed) {
      console.log(
        `[session ${sessionId}] WARNING: never successfully parsed a tab list packet, every "by X" name in a death message was trusted as a real player. If mobs/environmental causes show up as PvP kills, this is why; check debug-packets.log for the real player_info packet shape.`,
      );
    }
    if (sessionDebug.errors.length) {
      console.log(`[session ${sessionId}] ${sessionDebug.errors.length} internal parsing error(s) were caught this session, see the debug summary for details.`);
    }
    if (sessionDebug.relayErrors.length) {
      console.log(`[session ${sessionId}] ${sessionDebug.relayErrors.length} packet relay error(s) occurred, see the debug summary for the packet name(s)/hex involved. This is the most likely cause of any "Connection Lost" on the real client.`);
    }

    writeSessionDebugFile(reason);
  }

  clientConn.on("end", () => {
    console.log(`[session ${sessionId}] real client disconnected`);
    finalizeAndSave("client_disconnected");
    if (!hypixelClient.ended) hypixelClient.end();
  });

  hypixelClient.on("end", () => {
    console.log(`[session ${sessionId}] Hypixel connection closed`);
    finalizeAndSave("hypixel_disconnected");
    if (!clientConn.ended) clientConn.end();
  });

  hypixelClient.on("error", (err) => {
    console.error(`[session ${sessionId}] Hypixel connection error:`, err.message);
    sessionDebug.errors.push({ where: "hypixelClient error event", message: err.message, stack: err.stack });
    if (automator) automator.onConnectionError(err);
    if (discordRuntime && !discordRuntime.control) discordRuntime.recorder.fail("Recorder connection error. Reconnect the Minecraft client, then use /retry.");
  });
  clientConn.on("error", (err) => {
    console.error(`[session ${sessionId}] client connection error:`, err.message);
    sessionDebug.errors.push({ where: "clientConn error event", message: err.message, stack: err.stack });
  });
  return {client:hypixelClient,close:reason=>finalizeAndSave(reason)};
}

const server = mc.createServer({
  "online-mode": true,
  port: config.listenPort,
  host: config.listenHost,
  version: config.protocolVersion,
  keepAlive: true,
});

let activeClient = null;
server.on("login", (clientConn) => {
  if(discordRuntime?.control){clientConn.end('The recorder now connects automatically. Use the Scority website to control its connection.');return;}
  if (activeClient) {
    clientConn.end("A replay proxy session is already connected.");
    return;
  }
  activeClient = clientConn;
  clientConn.once("end", () => { activeClient = null; });
  startProxySession(clientConn);
});

if(discordRuntime?.control)discordRuntime.control.bind(worker=>startProxySession(headlessPeer(),{...discordRuntime,recorder:worker.recorder},worker));

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    console.log(`${signal}: closing connections and saving the active replay`);
    server.close();
  });
}

server.on("error", (err) => {
  logFatal("local server error", err);
});

console.log(`Replay proxy listening on ${config.listenHost}:${config.listenPort}`);
console.log(`Point your Minecraft client (version ${config.protocolVersion}) at that address.`);
console.log(`First connection will prompt Microsoft device-code auth in this terminal.`);
console.log(`Every session now also writes output/session-<id>-debug.json (packet counts, samples, errors) regardless of DEBUG_PACKETS.`);
if (DEBUG) console.log(`Debug packet logging is ON -> ${debugLogPath} (preview length ${PREVIEW_LEN || "unlimited"} chars)`);
