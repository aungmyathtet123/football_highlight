// Bound per-input decoder threads: AV1's automatic thread selection can spend
// minutes buffering/decoding before a low-fps analysis encode emits a frame.
// Input options reset at each -i. Preserve explicit caller budgets and filters.
export function boundedFfmpegArgs(args, threads = 2) {
  if (!args.includes('-i')) return [...args];
  if (!Number.isInteger(threads) || threads < 1) throw new Error('Invalid FFmpeg thread budget');
  const result=[];
  let inputThreads=false;
  for(let index=0;index<args.length;index++) {
    const arg=args[index];
    if (/^-threads(?::.*)?$/.test(arg)) inputThreads=true;
    if(arg==='-i') {
      if(!inputThreads) result.push('-threads',String(threads));
      result.push(arg,args[++index]);
      inputThreads=false;
    } else result.push(arg);
  }
  if(!args.includes('-filter_threads')) result.unshift('-filter_threads','1');
  if(!args.includes('-filter_complex_threads')) result.unshift('-filter_complex_threads','1');
  // Encoder options are separate from decoder options. Existing render
  // budgets remain untouched; add a bounded budget only for an unbounded
  // single-output H.264/H.265 encoder.
  const lastInput=result.lastIndexOf('-i');
  const encoderIndex=result.findIndex((arg,index)=>index>lastInput && arg==='-c:v'
    && ['libx264','libx265'].includes(result[index+1]));
  if(encoderIndex>=0 && !result.slice(lastInput+2).some(arg=>/^-threads(?::.*)?$/.test(arg)))
    result.splice(encoderIndex+2,0,'-threads',String(threads));
  return result;
}
