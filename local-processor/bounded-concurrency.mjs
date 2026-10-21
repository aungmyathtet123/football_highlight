export async function mapWithConcurrency(items, requestedLimit, mapper) {
  const source = Array.from(items || []);
  if (!source.length) return [];
  const limit = Math.max(1, Math.min(source.length, Math.floor(Number(requestedLimit) || 1)));
  const results = new Array(source.length);
  let cursor = 0;
  let failed = false;
  async function worker() {
    while (!failed && cursor < source.length) {
      const index = cursor;
      cursor += 1;
      try { results[index] = await mapper(source[index], index); }
      catch (error) { failed = true; throw error; }
    }
  }
  // Do not start a retry while siblings from the failed pass still mutate
  // progress or call the provider. Let already-started work finish/cache first.
  const settled = await Promise.allSettled(Array.from({ length: limit }, worker));
  const failure = settled.find(result => result.status === "rejected");
  if (failure) throw failure.reason;
  return results;
}

// Consume immutable checkpoints as a producer finishes them. Unlike mapping a
// completed array, this lets review overlap detection without starting a model
// call for an incomplete scene or exceeding the configured review concurrency.
export function createStreamingWorkQueue(requestedLimit, mapper) {
  const limit=Math.max(1,Math.floor(Number(requestedLimit)||1));
  const pending=[],results=[];
  let active=0,index=0,closed=false,failure,finish;
  function settle() {
    if(closed&&active===0&&(!pending.length||failure)&&finish) {
      const current=finish;finish=undefined;
      failure?current.reject(failure):current.resolve(results);
    }
  }
  function pump() {
    while(!failure&&active<limit&&pending.length) {
      const task=pending.shift();active++;
      Promise.resolve().then(()=>mapper(task.value,task.index))
        .then(value=>{results[task.index]=value;},error=>{failure ||= error;})
        .finally(()=>{active--;pump();settle();});
    }
    settle();
  }
  return {
    enqueue(value) {
      if(closed) throw new Error('Cannot add work after the streaming queue is drained.');
      if(failure) return false;
      pending.push({value,index:index++});pump();return true;
    },
    drain() {
      if(closed) throw new Error('The streaming queue can only be drained once.');
      closed=true;
      return new Promise((resolve,reject)=>{finish={resolve,reject};pump();});
    },
  };
}
