// accuracy requires independent labels
export function evaluateDamage(events, labels) {
  const bySequence=new Map(events.map(event=>[event.sequence,event]));
  const seen=new Set();let correct=0,assigned=0,unassigned=0;
  const comparisons=[];
  for(const label of labels) {
    if(!Number.isInteger(label.sequence) || seen.has(label.sequence))throw new Error('Labels need unique integer packet sequences.');
    seen.add(label.sequence);
    if(label.attacker!==null && (typeof label.attacker!=='string' || !/^[A-Za-z0-9_]{1,16}$/.test(label.attacker)))throw new Error('Each label needs an attacker name or null for non-player damage.');
    const event=bySequence.get(label.sequence);if(!event)throw new Error(`No health-loss event for sequence ${label.sequence}.`);
    const hasAssignment=event.attacker!=null;
    const match=hasAssignment && label.attacker!==null && event.attacker.toLowerCase()===label.attacker.toLowerCase();
    if(hasAssignment)assigned++;else unassigned++;
    if(match)correct++;
    comparisons.push({sequence:label.sequence,expected:label.attacker,predicted:event.attacker,correct:hasAssignment?match:null});
  }
  return {labeledEvents:labels.length,assigned,correct,incorrect:assigned-correct,unassigned,
    accuracy:assigned?correct/assigned:null,coverage:labels.length?assigned/labels.length:null,
    definition:'Accuracy among assigned labeled events; abstentions are reported separately. Unassigned is not a claim of environmental damage.',comparisons};
}
