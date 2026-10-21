import fs from 'node:fs';
import {evaluateDamage} from '../lib/damage-evaluation.js';
const [scored,labels]=process.argv.slice(2);
if(!scored || !labels){console.log('node scripts/evaluate-damage.js <scored.json> <labels.json>');process.exit(1);}
const payload=JSON.parse(fs.readFileSync(scored,'utf8'));
console.log(JSON.stringify(evaluateDamage(payload.tracking.damageEvents,JSON.parse(fs.readFileSync(labels,'utf8'))),null,2));
