// Reserve before asynchronous request validation, not after it. This prevents
// concurrent retry requests from both resetting and scheduling the same job.
export function createJobQueue(onError = console.error) {
  const pending = new Set();
  let tail = Promise.resolve();
  return {
    has: id => pending.has(id),
    async submit(id, prepare, execute) {
      if (pending.has(id)) return false;
      pending.add(id);
      try {
        if (await prepare() === false) { pending.delete(id); return false; }
      } catch (error) { pending.delete(id); throw error; }
      tail = tail.then(() => execute()).catch(error => {
        try { onError(error); } catch { /* A logger cannot poison the queue. */ }
      }).finally(() => pending.delete(id));
      return true;
    },
    idle: () => tail,
  };
}
