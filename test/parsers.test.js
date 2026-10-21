import test from 'node:test';
import assert from 'node:assert/strict';
import { parseMessage, flattenToText } from '../lib/death-parser.js';
import { parseActionBar } from '../lib/actionbar-parser.js';
import { Match } from '../lib/match.js';
const colors = { red: ['red', 'dark_red'], green: ['green', 'dark_green'] };

test('legacy HUD formatting does not become timer or speed digits', () => {
  assert.deepEqual(parseActionBar({text: '§aPlaying      §e00:12 / 19:32      §61.0x'}),
    { state: 'playing', elapsedSec: 12, totalSec: 1172, speed: 1 });
  assert.equal(parseActionBar('Playing 00:99 / 19:32 1.0x'), null);
  assert.equal(parseActionBar('Playing 00:12 / 19:32 1..0x'), null);
});
test('arrays and legacy colors preserve names and teams', () => {
  assert.equal(flattenToText([{text:'Alice ',color:'red'}, {text:'died.'}]), 'Alice died.');
  const e = parseMessage('§cAlice §7was killed by §aBob§7.');
  assert.equal(e.victim, 'Alice');
  assert.equal(e.killer, 'Bob');
  assert.equal(e.victimColor, 'red');
  assert.equal(e.killerColor, 'green');
});
test('environmental final deaths count as eliminations', () => {
  const e = parseMessage('Alice fell into the void. FINAL KILL!');
  assert.equal(e?.finalKill, true);
  assert.equal(e.killer, null);
});
test('empty roster uses the same fallback as an absent roster', () => {
  assert.equal(parseMessage('Alice was killed by Bob.', new Set()).killer, 'Bob');
});
test('colored chat and join messages are not deaths', () => {
  const match = new Match({teamColors: colors});
  const roster = new Set(['Alice', 'Bob']);
  for (const text of ['§cAlice§7: hello §aBob§7.', '§cAlice§7 joined.']) {
    assert.equal(parseMessage(text, roster, match.resolveTeam), null);
  }
});
test('scoring, rewind deduplication, and repeated exports', () => {
  const m = new Match({teamColors: colors});
  m.addOnlinePlayer('Spectator');
  const kill = parseMessage('§aBob §7was killed by §cAlice§7.');
  m.handleParsedMessage(kill);
  assert.equal(m.killFeed.length, 0);
  for (let t=1; t<=3; t++) {
    m.updateActionBar({state:'playing',elapsedSec:t,totalSec:20,speed:1});
    m.handleParsedMessage(kill);
    m.handleParsedMessage(kill);
  }
  const a = m.toJSON();
  assert.equal(a.players.Alice.kills, 3);
  assert.equal(a.players.Alice.multiKills[3], 1);
  assert.equal(a.headToHead.Bob.Alice.deaths, 3);
  assert.equal(a.players.Spectator, undefined);
  const warnings = [...a.warnings];
  m.toJSON();
  assert.deepEqual(m.warnings, []);
  assert.deepEqual(a.warnings, warnings);
});
test('empty match awards do not name excluded tab-list spectators', () => {
  const m = new Match(); m.addOnlinePlayer('Spectator');
  assert.equal(m.toJSON().awards.mostKills, null);
  assert.equal(m.toJSON().awards.longestStreak, null);
});
test('names sharing punctuation or split across components still resolve teams', () => {
  const e=parseMessage({text:'',extra:[{text:'Al',color:'red'},{text:'ice',color:'red'},
    {text:' was killed by '},{text:'Bob.',color:'green'}]});
  assert.equal(e.victimColor,'red'); assert.equal(e.killerColor,'green');
});
test('valid usernames cannot collide with object prototypes in exported stats', () => {
  const m=new Match({onlyRecordWhilePlaying:false});
  m.handleParsedMessage(parseMessage('Bob was killed by __proto__.'));
  const out=JSON.parse(JSON.stringify(m.toJSON()));
  assert.equal(out.players.__proto__.kills,1);
  assert.equal(out.headToHead.__proto__.Bob.kills,1);
});
