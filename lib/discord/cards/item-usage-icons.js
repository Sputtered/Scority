import {createCanvas,loadImage} from '@napi-rs/canvas';
import {fileURLToPath} from 'node:url';

const definitions=[
  ['goldenApplesEaten','golden_apple'],
  ['ironSwordLives','iron_sword'],
  ['goldenPickaxeLives','golden_pickaxe'],
  ['ironAxeLives','iron_axe'],
  ['milkBucketLives','milk_bucket'],
];
const texture=name=>loadImage(fileURLToPath(new URL(`../../../assets/minecraft/${name}.png`,import.meta.url)));
const [ascii,glint,...items]=await Promise.all([texture('ascii'),texture('enchanted_item_glint'),...definitions.map(([,name])=>texture(name))]);

const sprites=items.map((item,index)=>{
  const canvas=createCanvas(64,64),ctx=canvas.getContext('2d');
  ctx.imageSmoothingEnabled=false;ctx.drawImage(item,0,0,64,64);
  if(index>0&&index<4){
    ctx.globalCompositeOperation='source-atop';
    ctx.fillStyle=index===2?'rgba(172,105,235,.10)':'rgba(168,101,238,.20)';
    ctx.fillRect(0,0,64,64);ctx.globalAlpha=index===2?.10:.20;ctx.drawImage(glint,0,0,64,64);
  }
  return canvas;
});

const atlas=createCanvas(128,128),atlasCtx=atlas.getContext('2d');atlasCtx.drawImage(ascii,0,0);
const pixels=atlasCtx.getImageData(0,0,128,128).data,glyphWidths=new Map(),tints=new Map();
for(const char of '0123456789,-'){
  const code=char.charCodeAt(0);let right=0;
  for(let x=0;x<8;x++)for(let y=0;y<8;y++)if(pixels[(((code>>4)*8+y)*128+(code%16)*8+x)*4+3])right=Math.max(right,x+1);
  glyphWidths.set(code,right||5);
}
function tint(color){
  if(!tints.has(color)){
    const canvas=createCanvas(128,128),ctx=canvas.getContext('2d');ctx.drawImage(atlas,0,0);
    ctx.globalCompositeOperation='source-in';ctx.fillStyle=color;ctx.fillRect(0,0,128,128);tints.set(color,canvas);
  }
  return tints.get(color);
}
const formatCount=value=>Number.isFinite(value)&&value>=0?new Intl.NumberFormat('en-US',{maximumFractionDigits:0}).format(value):'-';
const countUnits=value=>[...formatCount(value)].reduce((sum,char)=>sum+glyphWidths.get(char.charCodeAt(0))+1,0)-1;
const spacing=(stats,size,pitch)=>pitch??Math.max(size+8,...definitions.map(([field])=>countUnits(stats?.[field])*2+4));

export function itemUsageWidth(stats,{size=26,pitch=32}={}){
  const stride=spacing(stats,size,pitch),inset=pitch===null?Math.max(0,stride-size-4):0;
  return stride*(definitions.length-1)+inset+size+3;
}

function drawCount(ctx,value,right,bottom,maxWidth){
  const codes=[...formatCount(value)].map(char=>char.charCodeAt(0));
  const units=codes.reduce((sum,code)=>sum+glyphWidths.get(code)+1,0)-1;
  const scale=units*2<=maxWidth?2:units<=maxWidth?1:maxWidth/units;
  let x=Math.round(right-units*scale);const y=Math.round(bottom-7*scale);
  for(const code of codes){
    for(const [dx,dy] of [[-1,0],[1,0],[0,-1],[0,1],[2,2]])ctx.drawImage(tint('#080c10'),(code%16)*8,(code>>4)*8,8,8,x+dx,y+dy,8*scale,8*scale);
    ctx.drawImage(tint('#f5f6f6'),(code%16)*8,(code>>4)*8,8,8,x,y,8*scale,8*scale);
    x+=(glyphWidths.get(code)+1)*scale;
  }
}

export function drawItemUsage(ctx,stats,x,y,{size=26,pitch=32}={}){
  const stride=spacing(stats,size,pitch),inset=pitch===null?Math.max(0,stride-size-4):0;
  ctx.save();ctx.imageSmoothingEnabled=false;
  definitions.forEach(([field],index)=>{
    const left=x+index*stride+inset;ctx.drawImage(sprites[index],left,y,size,size);
    drawCount(ctx,stats?.[field],left+size+1,y+size+1,stride-3);
  });
  ctx.restore();
}
