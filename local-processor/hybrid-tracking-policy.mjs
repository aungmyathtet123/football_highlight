export const HYBRID_TRACKING_VERSION = 6;

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
  return {...scene, recommendedCrop: undefined, trackingBrief: {
    ...brief, goalFocusX: null, payoffEvidence: null,
  }};
}

export function providerEvidenceMatches(provider, evidence) {
  if (!evidence) return false;
  if (provider === 'gemini') return evidence.provider === 'gemini-vision';
  if (provider === 'hybrid') return evidence.provider === 'hybrid-football'
    && evidence.hybridTrackingVersion === HYBRID_TRACKING_VERSION;
  return evidence.provider !== 'gemini-vision' && evidence.provider !== 'hybrid-football';
}
