import readline from "node:readline";
import { normalizeReplayId } from "./replay-id.js";

export async function promptReplayQueue() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  console.log("\nEnter the replay IDs to run through this session, one per line.");
  console.log('(A bare ID like "48213" becomes "/replay 48213" automatically, or type the full command yourself.)');
  console.log("Blank line when you're done entering replays.\n");

  const queue = [];
  await new Promise((resolve) => {
    rl.on("line", (line) => {
      const trimmed = line.trim();
      if (!trimmed) {
        rl.close();
        return;
      }
      const id = normalizeReplayId(trimmed);
      if (!id) {
        console.log("Enter one replay ID or /replay <id>.");
        return;
      }
      queue.push(`/replay ${id}`);
    });
    rl.on("close", resolve);
  });

  console.log(`Queued ${queue.length} replay(s): ${queue.join(", ") || "(none)"}\n`);
  return queue;
}

// the server claims entries atomically
export async function fetchApprovedReplayQueue(pipelineConfig, log = () => {}) {
  const { pendingReplaysUrl, apiKey } = pipelineConfig || {};
  if (!pendingReplaysUrl || !apiKey) return [];
  log(`auto-queue: fetching ${pendingReplaysUrl}...`);
  try {
    const res = await fetch(pendingReplaysUrl, {
      method: "GET",
      headers: { "x-api-key": apiKey },
      signal: AbortSignal.timeout(30_000),
    });
    log(`auto-queue: response HTTP ${res.status} ${res.statusText}`);
    if (!res.ok) {
      log(`auto-queue: fetch failed with HTTP ${res.status} ${res.statusText}, treating as "nothing new" this tick`);
      return [];
    }
    const body = await res.json();
    const replays = Array.isArray(body?.replays) ? body.replays : [];
    log(`auto-queue: site returned ${replays.length} newly-claimed replay(s)`);
    return replays.map((r) => ({ command: `/replay ${r.replayId}`, replayId: r.replayId, submissionId: r.id }));
  } catch (err) {
    log(`auto-queue: fetch threw: ${err.message}`);
    return [];
  }
}

export function startAutoQueuePolling(automator, pipelineConfig, log = () => {}) {
  const configuredInterval = Number(pipelineConfig.pollIntervalMs);
  const pollIntervalMs = Number.isFinite(configuredInterval) && configuredInterval > 0
    ? configuredInterval : 45_000;
  let inFlight = false;
  log(`auto-queue: polling ${pipelineConfig.pendingReplaysUrl} every ${pollIntervalMs}ms`);
  return setInterval(async () => {
    if (inFlight || automator.stopped || automator.broken) return;
    inFlight = true;
    try {
      const newEntries = await fetchApprovedReplayQueue(pipelineConfig, log);
      automator.queue.push(...newEntries);
      if (newEntries.length) automator.resumeIfIdle();
    } catch (err) {
      log(`auto-queue: poll failed: ${err.message}`);
    } finally {
      inFlight = false;
    }
  }, pollIntervalMs);
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class ReplayAutomator {
  constructor({ hypixelClient, automationConfig, onReplayFinished, onReplayStarting, log }) {
    this.hypixelClient = hypixelClient;
    this.cfg = automationConfig;
    this.onReplayFinished = onReplayFinished;
    this.onReplayStarting = onReplayStarting || (() => {});
    this.log = log || (() => {});

    this.queue = [];
    this.started = false;
    this.currentState = null;
    this.currentReplayId = null;
    this.currentSubmissionId = null;
    this.finishedAlready = false;
    this.movementTimer = null;
    this.lastKnownPosition = null;
    this.stopped = false;
    this.broken = false;
    this.activeReplay = false;
    this.runGeneration = 0;
    this.busy = false;
  }

  setQueue(queue, { shared = false } = {}) {
    this.queue = shared ? queue : [...queue];
    this.log(`automation: queue initialized with ${this.queue.length} entr(y/ies)`);
  }

  sendChat(message) {
    this._safeWrite("chat", { message });
  }

  selectHotbarSlot(slotIndexZeroBased) {
    this._safeWrite("held_item_slot", { slotId: slotIndexZeroBased });
  }

  rightClickAir() {
    // air clicks require signed direction and empty-slot sentinels
    this._safeWrite("block_place", {
      location: { x: -1, y: 255, z: -1 },
      direction: -1,
      heldItem: { blockId: -1 },
      cursorX: 0,
      cursorY: 0,
      cursorZ: 0,
    });
  }

  _safeWrite(name, data) {
    if (this.stopped || this.broken) return;
    try {
      this.hypixelClient.write(name, data);
    } catch (err) {
      this.log(`automation: write("${name}") threw synchronously: ${err.message}`);
      this._markBroken(err, name);
    }
  }

  // serialization errors can corrupt the stream
  onConnectionError(err) {
    if (this.broken) return;
    this._markBroken(err, null);
  }

  _markBroken(err, packetName) {
    this.broken = true;
    this._stopMovementGuard();
    this.log(
      `automation: HALTED after a connection/serialization error${packetName ? ` on "${packetName}"` : ""}: ${err.message}. ` +
        `Not sending any further automation packets this session, the stream may be corrupted past this point. ` +
        `Check output/debug-packets.log and the session debug JSON, fix the packet shape in lib/bot-orchestrator.js, then restart.`,
    );
  }

  async onClientSpawned() {
    if (this.started) {
      this.log("automation: onClientSpawned() called again but already started, ignoring");
      return;
    }
    this.started = true;
    this.busy = true;
    this.log(`automation: client spawned in (queue has ${this.queue.length} entr(y/ies)), waiting postSpawnDelayMs=${this.cfg.postSpawnDelayMs}ms before starting...`);
    await wait(this.cfg.postSpawnDelayMs);
    if (this.stopped || this.broken) return;
    this._startMovementGuard();
    this.log(`automation: movement/anti-AFK guard started (interval=${this.cfg.movementIntervalMs}ms)`);

    // reset server state before starting
    this.log("automation: proceeding through /lobby to the first queued replay (in case client spawned in limbo/elsewhere)");
    await this._lobbyThenRunNext();
  }

  async _lobbyThenRunNext() {
    if (this.stopped || this.broken) return;
    this.busy = true;
    this.log(`automation: sending "/lobby", waiting postLobbyDelayMs=${this.cfg.postLobbyDelayMs}ms before starting next replay`);
    this.sendChat("/lobby");
    await wait(this.cfg.postLobbyDelayMs);
    if (this.stopped || this.broken) {
      this.log(`automation: aborting after /lobby wait, stopped=${this.stopped} broken=${this.broken}`);
      return;
    }
    await this._runNext();
  }

  resumeIfIdle() {
    if (!this.started) {
      this.log("automation: resumeIfIdle() called but automation hasn't started yet (no client spawned in), nothing to resume");
      return;
    }
    if (this.stopped || this.broken) {
      this.log(`automation: resumeIfIdle() called but stopped=${this.stopped} broken=${this.broken}, nothing to resume`);
      return;
    }
    if (this.busy) {
      this.log("automation: resumeIfIdle() called but a replay is already in flight, it'll pick up the new entry naturally when it finishes");
      return;
    }
    if (this.queue.length === 0) {
      this.log("automation: resumeIfIdle() called but queue is still empty, nothing to resume");
      return;
    }
    this.log(`automation: queue was idle, ${this.queue.length} newly-polled replay(s) arrived, routing through /lobby before resuming (account may have been sitting idle anywhere)`);
    this._lobbyThenRunNext().catch((err) => this.log(`automation: resumeIfIdle()'s _lobbyThenRunNext threw: ${err.message}`));
  }

  async skipCurrent() {
    if (this.stopped || this.broken) return;
    this.activeReplay = false;
    this.finishedAlready = true;
    this.runGeneration += 1;
    this.currentReplayId = null;
    this.currentSubmissionId = null;
    this.currentState = null;
    await this._lobbyThenRunNext();
  }

  async _runNext() {
    if (this.stopped || this.broken) {
      this.log(`automation: _runNext() called but stopped=${this.stopped} broken=${this.broken}, doing nothing`);
      return;
    }
    if (this.queue.length === 0) {
      this.log("automation: queue empty, nothing left to run.");
      this._stopMovementGuard();
      this.busy = false;
      return;
    }

    this.busy = true;
    this.activeReplay = true;
    const generation = ++this.runGeneration;
    this._startMovementGuard();
    this.finishedAlready = false;
    this.currentState = null;
    this.playbackControlAt = 0;
    this.playbackControlCount = 0;

    const entry = this.queue.shift();
    if (!entry) { this.busy = false; this.activeReplay = false; return; }
    const isTracked = entry && typeof entry === "object";
    const id = normalizeReplayId(isTracked ? entry.command : entry);
    if (!id) {
      this._markBroken(new Error("Invalid replay command. Check the replay ID."), null);
      return;
    }
    const cmd = `/replay ${id}`;
    this.currentReplayId = id;
    this.currentSubmissionId = isTracked ? entry.submissionId : null;

    this.log(
      `automation: dequeued entry${isTracked ? ` (replayId=${this.currentReplayId}, submissionId=${this.currentSubmissionId})` : " (manual, untracked)"}, ${this.queue.length} remaining after this one`,
    );

    try {
      this.onReplayStarting(this.currentReplayId, this.currentSubmissionId);
    } catch (err) {
      this._markBroken(err, null);
      return;
    }

    this.log(`automation: sending chat command "${cmd}"`);
    this.sendChat(cmd);

    this.log(`automation: waiting postCommandDelayMs=${this.cfg.postCommandDelayMs}ms before working the menu`);
    await wait(this.cfg.postCommandDelayMs);
    if (this.stopped || this.broken || generation !== this.runGeneration) {
      this.log(`automation: aborting mid-_runNext() after postCommandDelayMs, stopped=${this.stopped} broken=${this.broken}`);
      return;
    }

    this.log(`automation: selecting menu hotbar slot ${this.cfg.menuSlot + 1} (zero-based ${this.cfg.menuSlot})`);
    this.selectHotbarSlot(this.cfg.menuSlot);
    this.log(`automation: right-clicking air ${this.cfg.rightClickCount}x, ${this.cfg.rightClickIntervalMs}ms apart, to open the replay menu`);
    for (let i = 0; i < this.cfg.rightClickCount; i++) {
      if (this.stopped || this.broken || generation !== this.runGeneration) return;
      this.log(`automation: menu right-click ${i + 1}/${this.cfg.rightClickCount}`);
      this.rightClickAir();
      if (i < this.cfg.rightClickCount - 1) await wait(this.cfg.rightClickIntervalMs);
    }

    if (this.stopped || this.broken || generation !== this.runGeneration) return;
    this.log(`automation: selecting speed hotbar slot ${this.cfg.speedSlot + 1} (zero-based ${this.cfg.speedSlot})`);
    this.selectHotbarSlot(this.cfg.speedSlot);
    this.log(`automation: right-clicking air ${this.cfg.speedSlotClickCount}x to confirm speed slot selection`);
    for (let i = 0; i < this.cfg.speedSlotClickCount; i++) {
      if (this.stopped || this.broken || generation !== this.runGeneration) return;
      this.log(`automation: speed-slot right-click ${i + 1}/${this.cfg.speedSlotClickCount}`);
      this.rightClickAir();
      if (i < this.cfg.speedSlotClickCount - 1) await wait(this.cfg.rightClickIntervalMs);
    }
    this.log("automation: menu sequence complete, now watching action bar for Playing/Finished state");
  }

  onActionBar(parsed) {
    if (!this.started || !this.activeReplay || this.stopped || this.broken || !parsed) {
      if (parsed) this.log(`automation: ignoring action-bar update (started=${this.started} stopped=${this.stopped} broken=${this.broken})`);
      return;
    }
    // speed up: 6, down: 2, pause: 4
    const target=this.cfg.replaySpeed;
    if(Number.isFinite(target) && ['playing','paused'].includes(parsed.state) && Number.isFinite(parsed.speed) &&
      (parsed.speed!==target || parsed.state==='paused') && Date.now()-(this.playbackControlAt || 0)>=1500) {
      if((this.playbackControlCount || 0)>=12){this._markBroken(new Error('Could not confirm the requested replay speed from the HUD.'),null);return;}
      this.playbackControlAt=Date.now();this.playbackControlCount=(this.playbackControlCount || 0)+1;
      this.selectHotbarSlot(parsed.speed===target?4:parsed.speed<target?6:2);
      this.rightClickAir();
      this.log(`automation: requesting ${target}x playback (HUD ${parsed.state} ${parsed.speed}x)`);
    }
    const prevState = this.currentState;
    this.currentState = parsed.state;

    if (prevState !== parsed.state) {
      this.log(`automation: action-bar state changed ${prevState ?? "(none)"} -> ${parsed.state} (${parsed.elapsedSec}/${parsed.totalSec}s, speed=${parsed.speed}x)`);
    }

    if (parsed.state === "finished" && !this.finishedAlready) {
      const timerComplete = parsed.totalSec != null && parsed.elapsedSec != null && parsed.elapsedSec >= parsed.totalSec;
      this.log(`automation: saw "finished" state, timerComplete=${timerComplete}, prevState=${prevState}`);
      // ignore completion before playback starts
      if (timerComplete || prevState === "playing") {
        this.finishedAlready = true;
        this._replayDone().catch(err => this._markBroken(err, null));
      } else {
        this.log('automation: "finished" seen but neither timerComplete nor prevState=="playing", ignoring as a likely stray/premature signal');
      }
    }
  }

  async _replayDone() {
    if (this.stopped || this.broken) {
      this.log(`automation: _replayDone() called but stopped=${this.stopped} broken=${this.broken}, doing nothing`);
      return;
    }
    this.activeReplay = false;
    this.runGeneration += 1;
    this.log(
      `automation: replay reports Finished (replayId=${this.currentReplayId ?? "n/a"}), saving and advancing queue. ${this.queue.length} entr(y/ies) remain queued.`,
    );
    try {
      if (typeof this.onReplayFinished === "function") {
        this.log("automation: calling onReplayFinished callback (save + upload)");
        await this.onReplayFinished("replay_finished");
        this.log("automation: onReplayFinished callback completed");
      }
    } catch (err) {
      this.log(`automation: onReplayFinished threw: ${err.message}`);
      this._markBroken(err, null);
      return;
    }

    this.currentReplayId = null;
    this.currentSubmissionId = null;

    if (this.queue.length === 0) {
      // polling may refill the queue during this wait
      this.log(`automation: queue is empty after this replay, waiting betweenReplaysDelayMs=${this.cfg.betweenReplaysDelayMs}ms, then checking again via /lobby (auto-queue polling may fill it before then)`);
      await wait(this.cfg.betweenReplaysDelayMs);
      await this._lobbyThenRunNext();
      return;
    }

    // leave stale replay state before advancing
    this.log(`automation: ${this.queue.length} replay(s) still queued, sending "/lobby", waiting postLobbyDelayMs=${this.cfg.postLobbyDelayMs}ms before starting next replay`);
    this.sendChat("/lobby");
    await wait(this.cfg.postLobbyDelayMs);
    if (this.stopped || this.broken) {
      this.log(`automation: aborting after postLobbyDelayMs, stopped=${this.stopped} broken=${this.broken}`);
      return;
    }

    this.log(`automation: waiting betweenReplaysDelayMs=${this.cfg.betweenReplaysDelayMs}ms before dequeueing next replay`);
    await wait(this.cfg.betweenReplaysDelayMs);
    await this._runNext();
  }

  trackPosition(pos) {
    const previous = this.lastKnownPosition || { x: 0, y: 0, z: 0, yaw: 0, pitch: 0 };
    const next = {};
    for (const [index, field] of ['x', 'y', 'z', 'yaw', 'pitch'].entries()) {
      next[field] = (pos.flags & (1 << index)) ? previous[field] + pos[field] : pos[field];
    }
    this.lastKnownPosition = next;
  }

  _startMovementGuard() {
    this._stopMovementGuard();
    if (this.stopped || this.broken) return;
    if (!this.cfg.movementIntervalMs) {
      this.log("automation: movementIntervalMs is 0, anti-AFK movement guard disabled");
      return;
    }
    this.movementTimer = setInterval(() => {
      if (this.broken || this.stopped) return;
      this._nudge().catch((err) => this.log(`automation: movement nudge failed: ${err.message}`));
    }, this.cfg.movementIntervalMs);
  }

  _stopMovementGuard() {
    if (this.movementTimer) {
      clearInterval(this.movementTimer);
      this.log("automation: movement/anti-AFK guard stopped");
    }
    this.movementTimer = null;
  }

  async _nudge() {
    if (this.stopped || this.broken) return;
    if (!this.lastKnownPosition) {
      this.log("automation: skipping movement nudge, no known position yet");
      return;
    }
    const { x, y, z, yaw, pitch } = this.lastKnownPosition;
    this.log(`automation: anti-AFK nudge starting from (${x.toFixed(2)}, ${y.toFixed(2)}, ${z.toFixed(2)}), holding ${this.cfg.movementHoldMs}ms`);
    this._safeWrite("position_look", { x: x + 0.1, y, z, yaw, pitch, onGround: true });
    await wait(this.cfg.movementHoldMs);
    if (this.stopped || this.broken) return;
    this._safeWrite("position_look", { x, y, z, yaw, pitch, onGround: true });
    this.log("automation: anti-AFK nudge complete, returned to original position");
  }

  stop() {
    this.log(`automation: stop() called (was: started=${this.started} busy=${this.busy} queue.length=${this.queue.length})`);
    this.stopped = true;
    this._stopMovementGuard();
  }
}
