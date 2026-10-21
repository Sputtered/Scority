import {createHash} from 'node:crypto';
import path from 'node:path';

export function recorderAccounts(value, cacheDir) {
  if (!value?.trim()) return [];
  const names=value.split(',').map(name=>name.trim());
  if (names.some(name=>!name || name.length>254 || /[\r\n\x00]/.test(name))) throw new Error('MINECRAFT_ACCOUNTS must contain comma-separated account identities.');
  if (names.length>10) throw new Error('Configure at most 10 recorder accounts.');
  if (new Set(names.map(name=>name.toLowerCase())).size!==names.length) throw new Error('Each recorder account must be unique.');
  return names.map((username,index)=>{
    const id=createHash('sha256').update(username.toLowerCase()).digest('hex').slice(0,16);
    return {id,username,label:`Account ${index+1}`,authCacheDir:path.join(cacheDir,id)};
  });
}
