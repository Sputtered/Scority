import {loadImage} from '@napi-rs/canvas';
import {fileURLToPath} from 'node:url';

const texture=name=>loadImage(fileURLToPath(new URL(`../../../assets/minecraft/${name}.png`,import.meta.url)));
const [diamond,barrier]=await Promise.all([texture('diamond'),texture('barrier')]);

export function drawVoidedDiamond(ctx,x,y,size){
  ctx.save();ctx.imageSmoothingEnabled=false;
  ctx.drawImage(diamond,x,y,size,size);
  ctx.drawImage(barrier,x,y,size,size);
  ctx.restore();
}
