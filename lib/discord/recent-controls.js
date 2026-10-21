import {gameLabel} from './store.js';

// original names keep old buttons valid
export function recentComponents(game) {
  const ref=gameLabel(game.id),disabled=Boolean(game.voided || game.payload.nameLinks?.excludedFromStats);
  const players=Object.keys(game.payload.players).filter(name=>/^[A-Za-z0-9_]{1,16}$/.test(name));
  const buttons=players.slice(0,players.length>25?24:25).map(name=>{
    const source=game.payload.nameLinks?.assignments.find(a=>a.main.toLowerCase()===name.toLowerCase())?.original || name;
    return {type:2,style:2,label:name,custom_id:`rp:public:gameplayer:${ref},${source}`,disabled};
  });
  if(players.length>25)buttons.push({type:2,style:2,label:'More players',custom_id:`rp:public:gameplayers:${ref}`,disabled});
  const rows=[];for(let i=0;i<buttons.length;i+=5)rows.push({type:1,components:buttons.slice(i,i+5)});
  return rows;
}
