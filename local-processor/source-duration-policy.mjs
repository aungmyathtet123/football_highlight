export const MINIMUM_SOURCE_SECONDS=180;
export function sourceDurationProblem(duration) {
  const seconds=Number(duration);
  if(!Number.isFinite(seconds)||seconds<=0) return 'The video duration could not be read. Choose a valid video file.';
  if(seconds<MINIMUM_SOURCE_SECONDS) return `The original video must be at least 3 minutes long. This video is ${Math.floor(seconds/60)}:${String(Math.floor(seconds%60)).padStart(2,'0')}.`;
  return null;
}
export function assertSourceDuration(duration) {
  const message=sourceDurationProblem(duration);
  if(message) {const error=new Error(message);error.code='SOURCE_VALIDATION';throw error;}
}
