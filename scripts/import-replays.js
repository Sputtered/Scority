import fs from 'node:fs';
import path from 'node:path';
import { ReplayStore } from '../lib/discord/store.js';

const root=path.resolve(process.argv[2] || './output');
const store=new ReplayStore(path.resolve(process.env.REPLAY_DATABASE || './data/replays.sqlite'));
let imported=0,duplicates=0,skipped=0;
function visit(dir) {
  for (const entry of fs.readdirSync(dir,{withFileTypes:true})) {
    const filename=path.join(dir,entry.name);
    if (entry.isDirectory()) visit(filename);
    else if (entry.isFile() && /^replay-.*\.json$/.test(entry.name)) {
      try {
        const json=JSON.parse(fs.readFileSync(filename,'utf8'));
        if (json.match?.endReason!=='replay_finished') { skipped++; continue; }
        const before=store.db.prepare('SELECT COUNT(*) AS count FROM games').get().count;
        store.importGame(json);
        if (store.db.prepare('SELECT COUNT(*) AS count FROM games').get().count>before) imported++; else duplicates++;
      } catch (err) { skipped++; console.warn(`Skipped ${filename}: ${err.message}`); }
    }
  }
}
try {
  visit(root);
  console.log(`Imported ${imported} completed game(s); ${duplicates} duplicates; ${skipped} incomplete/invalid recordings skipped.`);
} catch (err) { console.error(`Import failed: ${err.message}`); process.exitCode=1; }
finally { store.close(); }
