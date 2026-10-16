export const HYBRID_TRACKING_VERSION = 7;

export function keyframeProvider(value = 'gemini') {
  const provider = String(value).trim().toLowerCase();
  if (!['hybrid','gemini','local'].includes(provider)) throw new Error('KEYFRAME_PROVIDER must be hybrid, gemini, or local');
  return provider;
}

// An LLM's result rectangle is a hypothesis, not a detected football. Feeding
// that rectangle back into ball association made a false goal claim steer the
// tracker toward a boot/spare ball while excluding the real moving ball.
export function hybridDetectorScene(scene) {
  const {actionGuide,initialBallFocusX,shotDestination,...brief}=scene.trackingBrief||{};
  const duration=Number(scene.endTime)-Number(scene.startTime);
  const local=key=>Number.isFinite(brief[key])?brief[key]-Number(scene.startTime):null;
  const contact=local('contactTime'),flight=local('flightStartTime');
  const payoff=local('payoffStartTime'),payoffEnd=local('payoffEndTime');
  // A source interval can be trimmed after its phase hint was saved. The
  // old review also wrote identical payoff start/end timestamps. Neither is
  // a usable action clock for a new independent crop review.
  const invalidClock=duration>=1.5 && (
    contact===null || payoff===null || contact<.15 || contact>duration-.35
    || payoff<Math.max(contact,flight??contact)+.08 || payoff>duration-.05
    || payoffEnd!==null && payoffEnd-payoff<.08);
  const timing=invalidClock ? Object.fromEntries(Object.entries(brief).filter(([key])=>
    !['originTime','contactTime','flightStartTime','handoffTime','payoffStartTime',
      'payoffEndTime','annotationStartTime','annotationEndTime','timingEvidence'].includes(key))) : brief;
  return {...scene, recommendedCrop: undefined, trackingBrief: {
    ...timing, goalFocusX: null, payoffEvidence: null,
  }};
}

export function providerEvidenceMatches(provider, evidence) {
  if (!evidence) return false;
  if (provider === 'gemini') return evidence.provider === 'gemini-vision';
  if (provider === 'hybrid') return evidence.provider === 'hybrid-football'
    && evidence.hybridTrackingVersion === HYBRID_TRACKING_VERSION;
  return evidence.provider !== 'gemini-vision' && evidence.provider !== 'hybrid-football';
}
