import {applyAssists} from './assists.js';
import { makeTeamResolver, TEAM_COLORS, legacyTeamColor, gameTeams, teamKnown } from "./team-colors.js";
import { ReplayStats, NEW_STATS } from './replay-stats.js';

function formatClock(totalSeconds) {
  if (totalSeconds == null || Number.isNaN(totalSeconds)) return null;
  const s = Math.max(0, Math.round(totalSeconds));
  const mm = Math.floor(s / 60);
  const ss = s % 60;
  return `${String(mm).padStart(2, "0")}:${String(ss).padStart(2, "0")}`;
}

function emptyPlayer(username) {
  return {
    username,
    team: null,
    kills: 0,
    deaths: 0,
    bedBreaks: 0,
    finalKills: 0,
    currentStreak: 0,
    longestStreak: 0,
    // longer streaks include each shorter threshold
    multiKills: {},
  };
}

export class Match {
  constructor({ teamColors, onlyRecordWhilePlaying = true, meta = {}, protocolVersion = null } = {}) {
    this.resolveTeam = makeTeamResolver(teamColors || TEAM_COLORS);
    this.onlyRecordWhilePlaying = onlyRecordWhilePlaying;
    this.meta = meta;
    this.packetStats = protocolVersion ? new ReplayStats(protocolVersion,{parseDeaths:false}) : null;

    this.players = new Map();
    this.knownOnlinePlayers = new Set();

    this.killFeed = [];
    this.bedBreakLog = [];
    this.headToHead = new Map();

    this.replayState = "unknown";
    this.elapsedSec = null;
    this.totalSec = null;
    this.speed = null;

    this.firstBlood = null;
    this._seenEventKeys = new Set();
    this.warnings = [];
    this.participatingTeams = new Set();this.eliminatedTeams = new Set();
  }

  addOnlinePlayer(username) {
    this.knownOnlinePlayers.add(username);
    this._ensurePlayer(username);
  }

  removeOnlinePlayer(username) {
    // disconnected players still resolve for queued events
  }

  _ensurePlayer(username) {
    if (!this.players.has(username)) {
      this.players.set(username, emptyPlayer(username));
    }
    return this.players.get(username);
  }

  _setTeamIfColored(username, colorValue) {
    if (!username || !colorValue) return;
    const team = this.resolveTeam(colorValue);
    if (!team) return;
    const player = this._ensurePlayer(username);
    if (player.team && player.team !== team) {
      this.warnings.push(
        `${username} was previously seen as team "${player.team}" but chat color now resolves to "${team}", keeping the original.`,
      );
      return;
    }
    player.team = team;this.participatingTeams.add(team);this.packetStats?.setPlayerTeam(username,team);
  }

  updateActionBar({ state, elapsedSec, totalSec, speed }) {
    this.packetStats?.setPlayback({state,elapsedSec,totalSec,speed});
    this.replayState = state;
    this.elapsedSec = elapsedSec;
    this.totalSec = totalSec;
    this.speed = speed;
  }

  observePacket(name, data, state = 'play', sequence, receivedMs) {
    if (!this.packetStats) return;
    this.packetStats.observe(name,data,state,sequence,receivedMs);
    if (this.replayState !== 'playing') return;
    const w=this.packetStats.world;
    for (const p of this.packetStats.roster()) {
      if (!p.player || !/^[A-Za-z0-9_]{1,16}$/.test(p.player)) continue;
      this.addOnlinePlayer(p.player);
      const prefix=w.teams.get(p.team)?.prefix || '';
      const color=[...prefix.matchAll(/\u00a7([a-f0-9])/gi)].at(-1)?.[1]?.toLowerCase();
      this._setTeamIfColored(p.player,legacyTeamColor(color));
    }
  }

  _shouldRecord() {
    return !this.onlyRecordWhilePlaying || this.replayState === "playing";
  }

  _dedupeKey(kind, raw) {
    // rounded replay time deduplicates rewinds
    const t = this.elapsedSec != null ? Math.round(this.elapsedSec) : "unknown";
    return `${kind}|${t}|${raw}`;
  }

  handleParsedMessage(event) {
    if (!event) return;
    if (!this._shouldRecord()) return;

    const key = this._dedupeKey(event.type, event.raw);
    if (this._seenEventKeys.has(key)) return;
    this._seenEventKeys.add(key);

    if (event.type === "death") this._recordDeath(event);
    else if (event.type === "bed_break") this._recordBedBreak(event);
    else if(event.type==='team_eliminated' && teamKnown(event.team)){this.participatingTeams.add(event.team);this.eliminatedTeams.add(event.team);}
  }

  _recordDeath({ victim, victimColor, killer, killerColor, cause, rawCause, finalKill, raw }) {
    this._setTeamIfColored(victim,victimColor);this._setTeamIfColored(killer,killerColor);
    const evidence=this.packetStats?.recordDeath({victim,killer,cause,rawCause,finalKill,raw});
    const victimPlayer = this._ensurePlayer(victim);
    this._setTeamIfColored(victim, victimColor);
    victimPlayer.deaths += 1;
    victimPlayer.currentStreak = 0;

    let killerPlayer = null;
    if (killer) {
      killerPlayer = this._ensurePlayer(killer);
      this._setTeamIfColored(killer, killerColor);
      killerPlayer.kills += 1;
      if (finalKill) killerPlayer.finalKills += 1;

      killerPlayer.currentStreak += 1;
      if (killerPlayer.currentStreak > killerPlayer.longestStreak) {
        killerPlayer.longestStreak = killerPlayer.currentStreak;
      }
      if (killerPlayer.currentStreak >= 3) {
        const n = killerPlayer.currentStreak;
        killerPlayer.multiKills[n] = (killerPlayer.multiKills[n] || 0) + 1;
      }

      if (!this.headToHead.has(killer)) this.headToHead.set(killer, new Map());
      const killerRow = this.headToHead.get(killer);
      if (!killerRow.has(victim)) killerRow.set(victim, { kills: 0, deaths: 0 });
      killerRow.get(victim).kills += 1;

      if (!this.headToHead.has(victim)) this.headToHead.set(victim, new Map());
      const victimRow = this.headToHead.get(victim);
      if (!victimRow.has(killer)) victimRow.set(killer, { kills: 0, deaths: 0 });
      victimRow.get(killer).deaths += 1;

      if (!this.firstBlood) this.firstBlood = killer;
    }

    this.killFeed.push({
      ...(evidence?.sequence!=null?{sequence:evidence.sequence}:{}),
      ...(evidence?.lifeId!=null?{lifeId:evidence.lifeId}:{}),
      t: this.elapsedSec,
      time: formatClock(this.elapsedSec),
      victim,
      killer,
      cause,
      rawCause,
      finalKill,
      raw,
    });
  }

  _recordBedBreak({ team, breaker, breakerColor, raw }) {
    if(teamKnown(team))this.participatingTeams.add(team);
    this._setTeamIfColored(breaker, breakerColor);
    const breakerPlayer = this._ensurePlayer(breaker);
    breakerPlayer.bedBreaks += 1;

    this.bedBreakLog.push({ t: this.elapsedSec, time: formatClock(this.elapsedSec), team, breaker, raw });
  }

  // public winners require all opponents eliminated
  _determineWinner(warnings = []) {
    const sides=gameTeams({players:Object.fromEntries(this.players),match:{participatingTeams:[...this.participatingTeams]}});
    const finals=new Set(this.killFeed.filter(e=>e.finalKill).map(e=>e.victim));
    const eliminated=new Set(this.eliminatedTeams);
    for(const team of sides){
      const members=[...this.players.values()].filter(p=>p.team===team);
      if(members.length && members.every(p=>finals.has(p.username)))eliminated.add(team);
    }
    const alive=sides.filter(team=>!eliminated.has(team));
    let winner=null,winReason=null;
    if(sides.length>=2 && alive.length===1){winner=alive[0];winReason='elimination';}
    const last=this.killFeed.findLast(e=>e.finalKill);
    const lastTeam=last?.killer?this.players.get(last.killer)?.team:null;
    if(!winner && sides.length===2 && lastTeam && !eliminated.has(lastTeam)){
      winner=lastTeam;winReason='last_final_kill';
    }
    if(!winner)warnings.push('Winner check: could not determine a winner; more than one team may remain or elimination evidence is incomplete.');
    return {winner,winReason};
  }

  toJSON() {
    const extended = this.packetStats?.result();
    const players = Object.create(null);
    const teams = Object.fromEntries([...gameTeams({players:Object.fromEntries(this.players),match:{participatingTeams:[...this.participatingTeams]},bedBreaks:this.bedBreakLog}),'unassigned'].map(team=>[team,[]]));

    for (const [username, p] of this.players.entries()) {
      // exclude hidden accounts without activity or teams
      const hasActivity = p.kills > 0 || p.deaths > 0 || p.bedBreaks > 0;
      if (!hasActivity && !p.team) continue;

      const kd = p.deaths === 0 ? p.kills : Number((p.kills / p.deaths).toFixed(2));
      players[username] = {
        team: p.team,
        kills: p.kills,
        deaths: p.deaths,
        kd,
        bedBreaks: p.bedBreaks,
        finalKills: p.finalKills,
        longestStreak: p.longestStreak,
        multiKills: p.multiKills,
        ...(extended ? extended.players[username] || Object.fromEntries(NEW_STATS.map(key=>[key,null])) : {}),
      };
      (teams[p.team] || teams.unassigned).push(username);
    }

    const headToHead = Object.create(null);
    for (const [killer, row] of this.headToHead.entries()) {
      headToHead[killer] = Object.create(null);
      for (const [opponent, record] of row.entries()) {
        headToHead[killer][opponent] = record;
      }
    }

    const participants = [...this.players.values()].filter(p => Object.hasOwn(players, p.username));
    const byKills = [...participants].sort((a, b) => b.kills - a.kills);
    const byKd = [...participants]
      .filter((p) => p.kills > 0 || p.deaths > 0)
      .sort((a, b) => (b.deaths === 0 ? b.kills : b.kills / b.deaths) - (a.deaths === 0 ? a.kills : a.kills / a.deaths));
    const byStreak = [...participants].sort((a, b) => b.longestStreak - a.longestStreak);
    const noDeaths = participants.filter((p) => p.deaths === 0 && p.kills > 0).map((p) => p.username);

    const warnings = [...this.warnings];
    const { winner, winReason } = this._determineWinner(warnings);

    return applyAssists({
      match: {
        ...this.meta,
        totalDurationSec: this.totalSec,
        generatedAt: new Date().toISOString(),
        winner,
        winReason,
        participatingTeams:[...this.participatingTeams],
      },
      teams,
      players,
      killFeed: this.killFeed,
      bedBreaks: this.bedBreakLog,
      headToHead,
      awards: {
        mostKills: byKills[0]?.username || null,
        bestKD: byKd[0]?.username || null,
        longestStreak: byStreak[0] ? { player: byStreak[0].username, length: byStreak[0].longestStreak } : null,
        firstBlood: this.firstBlood,
        noDeaths,
      },
      warnings,
      ...(extended ? {tracking:extended.tracking,teamUpgrades:extended.teamUpgrades} : {}),
    });
  }
}
