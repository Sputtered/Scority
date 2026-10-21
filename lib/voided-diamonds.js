export const VOIDED_DIAMONDS_VERSION = 1;
const distance = (a,b) => Math.hypot(a.x-b.x,a.y-b.y,a.z-b.z);
const amount = n => Number.isInteger(n) && n>0;
const samePlayer = (a,b) => a && b && a.toLowerCase()===b.toLowerCase();

// require observed falls; ambiguous merges stay unresolved
export function resourceStackProvenance(items, classify=()=>({kind:'unknown'})) {
  const resources=[...items].filter(item=>item.lifecycle);
  const state=new Map(),plans=new Map(),donorPlans=new Map(),plannedSources=new Map();
  const changes=resources.flatMap(item=>item.lifecycle.samples
    .filter((sample,index,all)=>index===0 || sample.count!==all[index-1].count)
    .map((sample,index)=>({item,sample,initial:index===0})))
    .sort((a,b)=>a.sample.seq-b.sample.seq);

  const donorCandidates=({item,sample})=>resources.filter(donor=>{
    const life=donor.lifecycle,removed=life.removed,last=life.samples.at(-1);
    return donor!==item && donor.resource===item.resource && donor.seq<sample.seq && removed && !life.pickups.length &&
      removed.position.y>=donor.voidBoundary && last.seq<=sample.seq &&
      amount(last.count) && Math.abs(removed.seq-sample.seq)<=128 &&
      Math.abs(removed.t-sample.t)<=Math.max(donor.resolution,item.resolution) &&
      distance(removed.position,sample.position)<=2 &&
      // metadata orders batched merges
      (!item.lifecycle.removed || item.lifecycle.removed.seq>=removed.seq);
  });
  const subsets=(candidates,target)=>{
    const found=[];
    if(candidates.length>12)return found;
    const visit=(index,total,picked)=>{
      if(found.length>1 || total>target)return;
      if(total===target){found.push(picked);return;}
      for(let i=index;i<candidates.length;i++)visit(i+1,total+candidates[i].lifecycle.samples.at(-1).count,[...picked,candidates[i]]);
    };
    visit(0,0,[]);return found;
  };

  // each donor belongs to one recipient
  for(const change of changes) {
    const {item,sample,initial}=change;
    const previous=item.lifecycle.samples.filter(s=>s.seq<sample.seq).at(-1)?.count;
    const candidates=donorCandidates(change);
    let donors=null,ambiguous=false;
    if(initial) {
      // new entities contribute at least one item
      const eligible=candidates.filter(d=>d.lifecycle.samples.at(-1).count<sample.count);
      // intermediate survivors already include their donors
      const fitting=eligible.filter(donor=>!eligible.some(other=>other!==donor &&
        plannedSources.get(other.generation)?.has(donor.generation)));
      const total=fitting.reduce((sum,d)=>sum+d.lifecycle.samples.at(-1).count,0);
      if(total>0 && total<sample.count)donors=fitting;
      else if(total>=sample.count && fitting.length)ambiguous=true;
    } else if(sample.count>previous) {
      const matches=subsets(candidates,sample.count-previous);
      if(matches.length===1)donors=matches[0];
      else ambiguous=true;
    } else if(sample.count<previous)ambiguous=true;
    const plan={...change,donors:donors??[],ambiguous};plans.set(sample,plan);
    const sources=plannedSources.get(item.generation)??new Set([item.generation]);
    if(!ambiguous)for(const donor of plan.donors)
      for(const generation of plannedSources.get(donor.generation)??[donor.generation])sources.add(generation);
    plannedSources.set(item.generation,sources);
    for(const donor of plan.donors) {
      const list=donorPlans.get(donor.generation)??[];list.push(plan);donorPlans.set(donor.generation,list);
    }
  }
  for(const list of donorPlans.values())if(list.length>1)for(const plan of list)plan.ambiguous=true;

  for(const change of changes) {
    const {item,sample,initial}=change,plan=plans.get(sample),origin=classify(item);
    let entry=state.get(item.generation);
    if(initial) {
      entry={player:origin.kind==='throw'?origin.player:null,resolved:origin.kind==='throw' && amount(sample.count),
        count:sample.count,initialQuantity:plan.ambiguous?null:sample.count-plan.donors.reduce((sum,d)=>sum+d.lifecycle.samples.at(-1).count,0),
        sources:new Set([item.generation]),consumedBy:null};
      state.set(item.generation,entry);
    }
    if(plan.ambiguous)entry.resolved=false;
    for(const donor of plan.donors) {
      const source=state.get(donor.generation);
      if(!source?.resolved || source.consumedBy || !samePlayer(source.player,entry.player))entry.resolved=false;
      if(source) {
        for(const generation of source.sources)entry.sources.add(generation);
        if(!plan.ambiguous)source.consumedBy=item.generation;
      }
    }
    entry.count=sample.count;
  }
  return {items:resources,state};
}

export function scoreVoidedDiamonds(items, classify) {
  const provenance=resourceStackProvenance(items,classify),{state}=provenance;
  const players=Object.create(null),events=[];let unresolvedEvents=0;
  for(const item of provenance.items.filter(item=>item.resource==='diamond')) {
    const life=item.lifecycle,entry=state.get(item.generation),origin=classify(item),removed=life.removed;
    if(life.pickups.length || entry?.consumedBy || ['generator','death'].includes(origin.kind))continue;
    const crossing=life.samples.find(sample=>sample.kind==='movement' && sample.position.y<item.voidBoundary);
    const fell=life.samples[0].position.y>=item.voidBoundary && crossing && removed && removed.position.y<item.voidBoundary;
    if(!fell)continue;
    const evidence={t:removed.t,sequence:removed.seq,throwTime:item.t,resource:'diamond',
      itemEntityId:item.entityId,generation:item.generation,sourceGenerations:[...(entry?.sources??[])],
      finalPosition:{...removed.position},voidBoundary:item.voidBoundary};
    if(!entry?.resolved || !entry.player || !amount(entry.count)) {
      unresolvedEvents++;
      events.push({kind:'void_unresolved',...evidence,reason:origin.kind==='unknown'?'unresolved_thrower':'unresolved_stack_merge'});
      continue;
    }
    players[entry.player]=(players[entry.player]??0)+entry.count;
    events.push({kind:'void',...evidence,player:entry.player,quantity:entry.count,attribution:'inferred',confidence:origin.confidence});
  }
  return {players,events,unresolvedEvents};
}
