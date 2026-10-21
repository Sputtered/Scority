export const DAMAGE_STATS = ['damageDealt','damageReceived'];
export const ITEM_STATS = ['goldenApplesEaten','ironSwordLives','goldenPickaxeLives','ironAxeLives','milkBucketLives'];
export const EXTENDED_STATS = ['diamondsCollected','emeraldsCollected','assists',...DAMAGE_STATS,'diamondsVoided',...ITEM_STATS];
export const damageTracked = tracking => tracking?.damage?.version>=1 && tracking.damage.status==='tracked' && tracking.damage.scope==='attributed-player-damage' && tracking.status!=='invalid';
export const assistsTracked = tracking => tracking?.assists?.version>=1 && tracking.assists.status==='tracked' && tracking.status!=='invalid';
export const voidedDiamondsTracked = tracking => tracking?.voidedDiamonds?.version>=1 && tracking.voidedDiamonds.status==='tracked' && tracking.status!=='invalid';
export const itemUsageTracked = tracking => tracking?.itemUsage?.version>=1 && tracking.itemUsage.status==='tracked' && tracking.status!=='invalid';
export const visibleStats = (player,tracking) => {
  let shown=damageTracked(tracking)?player:{...player,damageDealt:null,damageReceived:null,damageByOpponent:null};
  if(Object.hasOwn(shown,'diamondsVoided') && !voidedDiamondsTracked(tracking) && !shown.manualStats?.includes('diamondsVoided'))shown={...shown,diamondsVoided:null};
  if(!itemUsageTracked(tracking))shown={...shown,...Object.fromEntries(ITEM_STATS.map(stat=>[stat,null]))};
  return Object.hasOwn(shown,'assists') && !assistsTracked(tracking)?{...shown,assists:null,assistsByOpponent:null}:shown;
};
export const statNumber = value => Number.isFinite(value) ? new Intl.NumberFormat('en-US',{maximumFractionDigits:1}).format(value) : '—';
export const damageNumber = value => Number.isFinite(value) ? new Intl.NumberFormat('en-US',{maximumFractionDigits:0}).format(value) : '—';
export const percent = value => Number.isFinite(value) ? `${Math.round(value*100)}%` : '—';
export const damageLine = p => `${damageNumber(p.damageDealt)} dealt · ${damageNumber(p.damageReceived)} received HP`;
export const itemUsageLine = p => `${statNumber(p.goldenApplesEaten)} golden apples eaten\nLives with iron sword: ${statNumber(p.ironSwordLives)} · golden pickaxe: ${statNumber(p.goldenPickaxeLives)} · iron axe: ${statNumber(p.ironAxeLives)} · milk bucket: ${statNumber(p.milkBucketLives)}`;
export const extendedLine = p => `${statNumber(p.assists)} assists · ${statNumber(p.diamondsCollected)} diamonds · ${statNumber(p.emeraldsCollected)} emeralds\n${statNumber(p.diamondsVoided)} diamonds voided · PvP damage: ${damageLine(p)}\n${itemUsageLine(p)}`;
