import {EventEmitter} from 'node:events';

export function headlessPeer(){
  const peer=new EventEmitter();peer.state='play';peer.ended=false;peer.managed=true;
  peer.write=()=>{};peer.writeRaw=()=>{};
  peer.end=()=>{if(peer.ended)return;peer.ended=true;peer.emit('end');};return peer;
}

export function attachHeadlessViewer(client,{viewDistance=16}={}){
  let stopped=false,positioned=false,ticks=0,position={x:0,y:0,z:0,yaw:0,pitch:0};
  const send=(name,data)=>{if(!stopped&&!client.ended&&client.state==='play'){try{client.write(name,data);}catch(error){client.emit('error',error);}}};
  client.registerChannel('MC|Brand',['string',[]]);
  client.on('login',()=>{
    if(stopped)return;
    send('settings',{locale:'en_US',viewDistance,chatFlags:0,chatColors:true,skinParts:127});
    client.writeChannel('MC|Brand','Scority');
  });
  client.on('respawn',()=>{positioned=false;});
  client.on('position',data=>{
    if(stopped)return;
    for(const [key,bit] of [['x',1],['y',2],['z',4],['yaw',8],['pitch',16]])position[key]=((data.flags&bit)?position[key]:0)+data[key];
    positioned=true;send('position_look',{...position,onGround:false});
  });
  client.on('transaction',data=>send('transaction',{windowId:data.windowId,action:data.action,accepted:true}));
  const timer=setInterval(()=>{if(positioned){if(ticks++%20===0)send('position',{x:position.x,y:position.y,z:position.z,onGround:false});else send('flying',{onGround:false});}},50);
  const stop=()=>{stopped=true;clearInterval(timer);};
  client.once('end',stop);return stop;
}
