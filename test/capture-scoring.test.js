import test from 'node:test';
import assert from 'node:assert/strict';
import {createCaptureMatch, scorePacket} from '../lib/capture-scoring.js';

test('offline legacy chat JSON produces the same kills and teams as live chat', () => {
  const match = createCaptureMatch('1.8.9', 'fixture');
  match.updateActionBar({state:'playing',elapsedSec:0,totalSec:120,speed:4});
  scorePacket(match, {type:'packet',name:'chat',sequence:1,data:{position:0,
    message:JSON.stringify({text:'',extra:[{text:'Alice',color:'red'},
      {text:' was killed by '},{text:'Bob',color:'green'},{text:'.'}]})}});
  const players=match.toJSON().players;
  assert.equal(players.Alice.deaths,1);
  assert.equal(players.Alice.team,'red');
  assert.equal(players.Bob.kills,1);
  assert.equal(players.Bob.team,'green');
});
