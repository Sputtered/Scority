import {createCanvas,loadImage} from '@napi-rs/canvas';

export class AvatarCache {
  constructor({fetcher=globalThis.fetch,now=()=>Date.now(),timeout=3500,maxEntries=256}={}) {
    this.fetcher=fetcher;this.now=now;this.timeout=timeout;this.maxEntries=maxEntries;
    this.cache=new Map();this.pending=new Map();
  }
  async get(name) {
    if (!/^[A-Za-z0-9_]{1,16}$/.test(String(name))) return null;
    const key=name.toLowerCase(), cached=this.cache.get(key);
    if (cached?.expires>this.now()) return cached.image;
    if (this.pending.has(key)) return this.pending.get(key);
    const work=this.fetchAvatar(name).then(image=>{
      if (this.cache.size>=this.maxEntries) this.cache.delete(this.cache.keys().next().value);
      this.cache.set(key,{image,expires:this.now()+(image?24*3600_000:5*60_000)});
      return image;
    }).finally(()=>this.pending.delete(key));
    this.pending.set(key,work);return work;
  }
  async fetchAvatar(name) {
    const controller=new AbortController();
    const timer=setTimeout(()=>controller.abort(),this.timeout);
    try {
      const response=await this.fetcher(`https://mc-heads.net/avatar/${encodeURIComponent(name)}/128`,{signal:controller.signal});
      if (!response.ok || !response.headers.get('content-type')?.startsWith('image/png')) return null;
      if (Number(response.headers.get('content-length'))>256*1024) return null;
      const reader=response.body.getReader(), chunks=[];let size=0;
      try {
        while (true) {
          const {done,value}=await reader.read();if(done)break;
          size+=value.length;if(size>256*1024) { await reader.cancel();return null; }
          chunks.push(value);
        }
      } finally { reader.releaseLock(); }
      const buffer=Buffer.concat(chunks);
      // check dimensions before allocating
      if (buffer.length<24 || !buffer.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return null;
      const width=buffer.readUInt32BE(16),height=buffer.readUInt32BE(20);
      if (!width || !height || width>600 || height>600) return null;
      return await loadImage(buffer);
    } catch { return null; }
    finally { clearTimeout(timer);controller.abort(); }
  }
  async many(names) {
    const unique=[...new Set(names)];const images=new Map();
    for (let index=0;index<unique.length;index+=8) {
      await Promise.all(unique.slice(index,index+8).map(async name=>images.set(name.toLowerCase(),await this.get(name))));
    }
    return images;
  }
}

export function placeholderAvatar() {
  const canvas=createCanvas(8,8),ctx=canvas.getContext('2d');
  ctx.fillStyle='#333945';ctx.fillRect(0,0,8,8);
  ctx.fillStyle='#657081';ctx.fillRect(2,1,4,4);ctx.fillRect(1,5,6,3);
  return canvas;
}
