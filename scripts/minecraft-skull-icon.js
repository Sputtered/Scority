import {createCanvas,loadImage} from '@napi-rs/canvas';
import {fileURLToPath} from 'node:url';
import {writeFile} from 'node:fs/promises';
const source=await loadImage(fileURLToPath(new URL('../assets/minecraft/skeleton.png',import.meta.url)));
const canvas=createCanvas(32,32),ctx=canvas.getContext('2d');ctx.imageSmoothingEnabled=false;
function face(sx,sy,a,b,c,d,e,f){ctx.save();ctx.setTransform(a,b,c,d,e,f);ctx.drawImage(source,sx,sy,8,8,0,0,8,8);ctx.restore();}
face(0,8,1,.5,0,2,4,5); // side
face(8,8,2,0,0,2,12,9); // face
face(8,0,2,0,1,.5,4,5); // top
await writeFile(new URL('../assets/minecraft/skull.png',import.meta.url),await canvas.encode('png'));
