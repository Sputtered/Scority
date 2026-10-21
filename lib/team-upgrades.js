import {teamName,gameTeams} from './team-colors.js';
import {predictedLosses} from './protection-estimator.js';

export const UPGRADE_COLUMNS=[['sharpness','SHARP'],['protection1','P1'],['protection2','P2'],['protection3','P3'],['protection4','P4']];
const blank=status=>Object.fromEntries(UPGRADE_COLUMNS.map(([key])=>[key,{status,afterSec:null,bySec:null,evidence:[]}]));

// require two hits; glints cannot prove upgrades
export function inferTeamUpgrades(hits,{status='estimated',totalSec=Infinity,minEvidence=2,maxGapSeconds=120,tolerance=.002,teamNames=[]}={}) {
  const observed=[...teamNames,...hits.flatMap(hit=>[hit.team,hit.attackerTeam])].map(teamName);
  const names=gameTeams({players:Object.fromEntries(observed.filter(Boolean).map((team,i)=>[i,{team}]))});
  const teams=Object.fromEntries(names.map(team=>[team,blank(status==='estimated'?'unobserved':status)]));
  const result={version:1,status,model:'vanilla-1.8',accuracy:null,minEvidence,maxGapSeconds,teams,selectedHits:hits.length,unexplainedHits:0,
    timing:'Estimated acquired-by bounds from combat; not observed purchase times.'};
  if(status!=='estimated')return result;
  const observations=Object.fromEntries(names.map(team=>[team,{sharpness:[],protection:[]}]));
  for(const hit of hits){
    if(!Number.isFinite(hit.t))continue;
    const possibilities=[];
    for(let protection=0;protection<=4;protection++)for(const sharpness of hit.sharpnessOptions??[0,1]){
      for(const critical of hit.criticalOptions??[false,true]){
        if(predictedLosses({sword:hit.sword,armor:hit.armor,protection,sharpness,critical}).some(n=>Math.abs(n-hit.healthLoss)<=tolerance))
          possibilities.push({protection,sharpness});
      }
    }
    if(!possibilities.length){result.unexplainedHits++;continue;}
    for(const [kind,team] of [['protection',teamName(hit.team)],['sharpness',teamName(hit.attackerTeam)]]){
      if(!observations[team])continue;
      observations[team][kind].push({sequence:hit.sequence,t:hit.t,epoch:hit.epoch,resolution:hit.resolution??1,
        min:Math.min(...possibilities.map(p=>p[kind])),max:Math.max(...possibilities.map(p=>p[kind]))});
    }
  }
  for(const [team,kinds]of Object.entries(observations))for(const [kind,events]of Object.entries(kinds)){
    events.sort((a,b)=>a.sequence-b.sequence);
    for(let level=1;level<=(kind==='protection'?4:1);level++){
      const key=kind==='protection'?`protection${level}`:'sharpness';
      let lower=null,positive=[],estimate=null,contradiction=false;
      const epochs=new Set(events.map(e=>e.epoch));
      if(epochs.size>1){teams[team][key]= {...blank('invalid')[key]};continue;}
      for(const event of events){
        if(event.max<level){
          // permanent upgrades cannot decrease
          if(estimate){contradiction=true;break;}
          lower=event;positive=[];
        } else if(event.min>=level){
          positive=positive.filter(e=>event.t-e.t<=maxGapSeconds);
          if(!positive.some(e=>e.sequence===event.sequence))positive.push(event);
          if(!estimate && positive.length>=minEvidence){
            const first=positive[0];
            estimate={status:'estimated',afterSec:lower?.t??null,
              bySec:Math.min(totalSec,Math.ceil(first.t+Math.max(1,first.resolution))),
              firstEvidenceSec:first.t,corroboratedSec:event.t,
              evidence:positive.map(e=>e.sequence),priorEvidence:lower?.sequence??null};
          }
        }
      }
      teams[team][key]=contradiction?{...blank('conflicting')[key]}:estimate??teams[team][key];
    }
  }
  return result;
}

export function upgradeTime(value){
  if(value?.status!=='estimated'||!Number.isFinite(value.bySec))return '—';
  return `${Math.floor(value.bySec/60)}:${String(Math.floor(value.bySec%60)).padStart(2,'0')}`;
}
export function upgradeLine(timeline,team){
  return UPGRADE_COLUMNS.map(([key,label])=>`${label} ${upgradeTime(timeline?.teams?.[team]?.[key])}`).join(' · ');
}
