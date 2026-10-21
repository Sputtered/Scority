import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { createGunzip, constants } from 'node:zlib';
import { CaptureAnalysis } from '../lib/capture-analysis.js';

const filename = process.argv[2];
if (!filename) { console.log('node scripts/analyze-capture.js <packets.jsonl.gz> [--partial]'); process.exit(1); }
const partial = process.argv.includes('--partial');
const source = fs.createReadStream(filename);
const unzip = createGunzip(partial ? { finishFlush: constants.Z_SYNC_FLUSH } : {});
source.on('error', error => unzip.destroy(error));
const lines = readline.createInterface({ input: source.pipe(unzip), crlfDelay: Infinity });
let streamError;
unzip.on('error', error => { streamError = error; lines.close(); });
let analyzer;
for await (const line of lines) {
  if (!line.trim()) continue;
  let row;
  try { row = JSON.parse(line); } catch (error) { if (partial) continue; throw error; }
  if (row.type === 'capture') analyzer = new CaptureAnalysis(row.version);
  else if (analyzer) analyzer.observe(row);
}
if (streamError) throw streamError;
if (!analyzer) throw new Error('Missing capture header.');
const result = analyzer.result();
const output = path.join(path.dirname(filename), partial ? 'analysis.partial.json' : 'analysis.json');
fs.writeFileSync(output, JSON.stringify(result, null, 2));
console.log(JSON.stringify({ output, ended: result.captureEnded, replayFinished: result.replayFinished, replayTime: result.replayTime,
  healthSamples: result.health.sampleCount, fractionalHealthSamples: result.health.fractionalSamples,
  healthDecreases: result.health.lossChanges, healing: result.health.healingChanges,
  damageEvents: result.damageEvents.length, hurtAnimations: result.hurtAnimations.length,
  resourceSpawns: result.resources.spawnCount, resourcePickups: result.resources.pickupCount,
  collections: result.resources.collections,
  pickupQuantities: result.resources.pickupQuantityHistogram, metadataQuantities: result.resources.metadataQuantityHistogram,
  quantityDisagreements: result.resources.quantityDisagreements.length, enderChests: result.enderChests,
  chestVisits: result.chestVisits.length, deaths: result.deaths.length,
  undecodableFrames: result.undecodableFrames, chunkErrors: result.chunkErrors }, null, 2));
