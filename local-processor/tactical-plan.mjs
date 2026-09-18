// Keep a tactical freeze within the verified contact neighborhood. A short
// adjustment may avoid a missing detector sample; it never searches other plays.
export function tacticalFreezeAnchor(moment, evidence) {
  if (moment.effect !== "freeze_analysis" || !["ball","run","pass","map"].includes(moment.tacticalDrawing)) return undefined;
  const field=moment.freezeAtPhase === "origin" ? "originTime" : moment.freezeAtPhase === "payoff" ? "payoffStartTime" : "contactTime";
  const requested=Number(moment.trackingBrief?.[field]);
  if (!Number.isFinite(requested) || !evidence?.sourceRecords) return undefined;
  const records=evidence.sourceRecords;
  const candidates=records.filter((record,index)=>{
    if (Math.abs(evidence.sourceStartTime+record.time-requested)>.15 || !record.direct_ball || !record.joint_fit || record.subject_confidence<.85) return false;
    const next=records.slice(index,index+3);
    return next.length===3 && next.every((r,i)=>r.direct_ball && (!i || !r.scene_cut)
      && (moment.tacticalDrawing!=="run" || (r.player_track_id===record.player_track_id && r.subject_confidence>=.85)));
  }).sort((a,b)=>Math.abs(evidence.sourceStartTime+a.time-requested)-Math.abs(evidence.sourceStartTime+b.time-requested));
  return candidates.length ? evidence.sourceStartTime+candidates[0].time : undefined;
}
