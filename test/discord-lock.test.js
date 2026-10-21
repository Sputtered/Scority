import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {acquireRecorderLock} from '../lib/discord/lock.js';
test('only one recorder may own a database and shutdown releases the lock',t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'replay-lock-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const filename=path.join(dir,'db.lock'),release=acquireRecorderLock(filename);
  assert.throws(()=>acquireRecorderLock(filename),/Another recorder/);
  release();const next=acquireRecorderLock(filename);next();assert.equal(fs.existsSync(filename),false);
});
