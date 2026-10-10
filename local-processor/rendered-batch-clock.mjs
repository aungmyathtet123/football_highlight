// Container durations include small CFR/AAC encoder tails. Across several
// independently encoded batches these accumulate beyond the final clock's
// tolerance. Account for the observed tail at its actual batch boundary;
// never spread it across scenes, speed footage, or forgive a missing scene.
export function encodedBatchClock(result,measuredDuration,{maximumDrift=.12}={}) {
  const planned=Number(result?.timelineDuration),cuts=result?.synchronization;
  if(!Number.isFinite(measuredDuration)||measuredDuration<=0||!Number.isFinite(planned)||planned<=0
    ||!Array.isArray(cuts)||!cuts.length||Math.abs(measuredDuration-planned)>maximumDrift)
    throw new Error('Encoded scene batch disagrees with its verified scene clock.');
  for(let index=0;index<cuts.length;index++) {
    const cut=cuts[index],expected=index?cuts[index-1].visualStart+cuts[index-1].visualDuration:0;
    if(!cut.momentId||!Number.isFinite(cut.visualStart)||!Number.isFinite(cut.visualDuration)
      ||cut.visualDuration<=0||Math.abs(cut.visualStart-expected)>.002)
      throw new Error('Encoded scene batch must retain every scene in order.');
  }
  const last=cuts.at(-1);
  if(Math.abs(last.visualStart+last.visualDuration-planned)>.002
    ||measuredDuration-last.visualStart<=0) throw new Error('Encoded scene batch has an invalid ending clock.');
  return {...result,timelineDuration:measuredDuration,synchronization:cuts.map((cut,index)=>index===cuts.length-1?
    {...cut,visualDuration:measuredDuration-cut.visualStart}:({...cut})),
    encodingClockAdjustment:measuredDuration-planned};
}
