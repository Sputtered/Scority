import assert from 'node:assert/strict';
import { Match } from '../lib/match.js';
import { parseMessage } from '../lib/death-parser.js';
import { parseActionBar } from '../lib/actionbar-parser.js';

const match = new Match({teamColors:{red:['red'],green:['green']}});
match.updateActionBar(parseActionBar('§aPlaying §e00:01 / 00:10 §61.0x'));
match.handleParsedMessage(parseMessage('BED DESTRUCTION > Green Bed was destroyed by §cAlice§r!'));
for (let i=1;i<=4;i++) {
  match.updateActionBar(parseActionBar(`Playing 00:0${i} / 00:10 1.0x`));
  match.handleParsedMessage(parseMessage(`§aGreen${i} §7was killed by §cAlice§7. FINAL KILL!`));
}
const result=match.toJSON();
assert.equal(result.match.winner,'red');
assert.equal(result.match.winReason,'elimination');
assert.equal(result.players.Alice.kills,4);
assert.equal(result.players.Alice.bedBreaks,1);
console.table(result.players);
console.log('Dry run passed: four final kills, one bed break, red wins by elimination.');
