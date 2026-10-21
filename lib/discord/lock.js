import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

// only one process controls minecraft
export function acquireRecorderLock(filename) {
  fs.mkdirSync(path.dirname(filename),{recursive:true});
  const token=randomUUID();
  for (let attempt=0;attempt<2;attempt++) {
    try {
      const fd=fs.openSync(filename,'wx',0o600);
      try { fs.writeFileSync(fd,JSON.stringify({pid:process.pid,token})); } finally { fs.closeSync(fd); }
      return () => {
        try { if (JSON.parse(fs.readFileSync(filename,'utf8')).token===token) fs.unlinkSync(filename); } catch {}
      };
    } catch (err) {
      if (err.code!=='EEXIST') throw err;
      let owner;
      try { owner=JSON.parse(fs.readFileSync(filename,'utf8')); } catch { throw new Error(`Recorder lock is unreadable: ${filename}. Stop other instances before removing it.`); }
      if (!Number.isInteger(owner.pid) || owner.pid<1) throw new Error('Recorder lock has an invalid process ID.');
      try { process.kill(owner.pid,0); } catch (check) {
        if (check.code==='ESRCH') { fs.unlinkSync(filename); continue; }
      }
      throw new Error(`Another recorder is running (PID ${owner.pid}). Stop it before starting this app.`);
    }
  }
  throw new Error('Could not acquire the recorder lock.');
}
