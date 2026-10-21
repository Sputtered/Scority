// preserve captured chat
export const nameKey = name => String(name || '').toLowerCase();
export function recordedNames(payload) {
  const names = new Map();
  const add = name => { if (typeof name === 'string' && name && !names.has(nameKey(name))) names.set(nameKey(name),name); };
  Object.keys(payload.players || {}).forEach(add);
  for (const event of payload.killFeed || []) { add(event.killer); add(event.victim); }
  for (const event of payload.bedBreaks || []) add(event.breaker);
  for (const players of Object.values(payload.teams || {})) players.forEach(add);
  for (const [player, opponents] of Object.entries(payload.headToHead || {})) { add(player); Object.keys(opponents).forEach(add); }
  for (const award of ['mostKills','bestKD','firstBlood']) add(payload.awards?.[award]);
  add(payload.awards?.longestStreak?.player);
  (payload.awards?.noDeaths || []).forEach(add);
  return [...names.values()];
}

export function projectNames(payload, links, overrides) {
  const globals = new Map(links.map(link=>[nameKey(link.alias),link]));
  const local = new Map(overrides.map(link=>[nameKey(link.original),link]));
  const assignments = recordedNames(payload).map(original=>{
    const override=local.get(nameKey(original)), link=globals.get(nameKey(original));
    // game edits override links; explicit resets stay
    const edited=override && (nameKey(override.main)===nameKey(original)?original:
      globals.get(nameKey(override.main))?.main || override.main);
    return {original,main:edited || link?.main || original,
      link:override?(nameKey(override.main)===nameKey(original)?null:globals.get(nameKey(override.main))?.alias || null):link?.alias || null,
      scope:override?'game':link?'all':'original',kind:override?'edit':link?.kind || null};
  });
  const groups=new Map();
  for (const entry of assignments) {
    const key=nameKey(entry.main), group=groups.get(key) || {main:entry.main,names:[]};
    group.names.push(entry.original); groups.set(key,group);
  }
  const conflicts=[...groups.values()].filter(group=>group.names.length>1);
  payload.nameLinks={assignments,conflicts,excludedFromStats:conflicts.length>0};
  // exclude conflicting scoreboards from totals
  if (conflicts.length) return payload;
  const names=new Map(assignments.map(entry=>[nameKey(entry.original),entry.main]));
  const rename=name=>names.get(nameKey(name)) || name;
  payload.players=Object.fromEntries(Object.entries(payload.players).map(([name,stats])=>[rename(name),stats]));
  for(const stats of Object.values(payload.players))if(stats.damageByOpponent)stats.damageByOpponent=Object.fromEntries(Object.entries(stats.damageByOpponent).map(([name,value])=>[rename(name),value]));
  for(const stats of Object.values(payload.players))if(stats.assistsByOpponent)stats.assistsByOpponent=Object.fromEntries(Object.entries(stats.assistsByOpponent).map(([name,value])=>[rename(name),value]));
  for(const event of payload.tracking?.assistEvents || [])for(const field of ['helper','victim','killer'])event[field]=rename(event[field]);
  for(const event of payload.tracking?.itemUsageEvents || [])if(event.player)event.player=rename(event.player);
  for (const event of payload.killFeed) { event.killer=rename(event.killer); event.victim=rename(event.victim); }
  for (const event of payload.bedBreaks) event.breaker=rename(event.breaker);
  for (const event of payload.tracking?.damageEvents || []) {
    event.victim=rename(event.victim);event.attacker=rename(event.attacker);
    for(const candidate of event.candidates || []){
      if(candidate.player)candidate.player=rename(candidate.player);
      if(candidate.name)candidate.name=rename(candidate.name);
    }
  }
  for (const event of payload.tracking?.resourceEvents || []) {
    for(const property of ['player','victim','killer'])if(event[property])event[property]=rename(event[property]);
  }
  if (payload.teams) payload.teams=Object.fromEntries(Object.entries(payload.teams).map(([team,players])=>[team,players.map(rename)]));
  if (payload.headToHead) payload.headToHead=Object.fromEntries(Object.entries(payload.headToHead).map(([name,opponents])=>[
    rename(name),Object.fromEntries(Object.entries(opponents).map(([other,stats])=>[rename(other),stats])),
  ]));
  if (payload.awards) {
    for (const award of ['mostKills','bestKD','firstBlood']) if (payload.awards[award]) payload.awards[award]=rename(payload.awards[award]);
    if (payload.awards.longestStreak) payload.awards.longestStreak.player=rename(payload.awards.longestStreak.player);
    if (payload.awards.noDeaths) payload.awards.noDeaths=payload.awards.noDeaths.map(rename);
  }
  return payload;
}
