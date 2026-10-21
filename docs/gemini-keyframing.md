# Gemini-controlled football framing

`KEYFRAME_PROVIDER=gemini` is the default in the processor. The old local
player/ball detector is not invoked in this mode and is not an automatic fallback.

For each locked source scene the processor:

1. Supplies timestamp-labelled images and the original scene video to Gemini.
2. Validates image indexes, observed ball/player boxes and complete action phases.
   Gemini's native `[ymin,xmin,ymax,xmax]` box order is converted explicitly to
   screen X/Y; it is never treated as X-first coordinates.
3. Computes a fixed-scale crop using only those visual observations. It prefers
   a still camera when all required subjects fit and otherwise minimizes motion.
4. Renders a scene-level portrait preview using the same position expression as
   the final renderer.
5. Asks Gemini to verify that actual preview. Missing setup/contact/outcome,
   wrong subjects, off-screen ball or unstable movement cannot pass.
6. Repairs the same scene up to three times. A rejected scene is not silently
   replaced by a player-only or referee scene. Only verified results are cached.

Player-only reaction/decision footage is distinct from gameplay. A decision
cannot prove that the goal itself appeared. During ball flight the original
shooter need not remain in the crop; the ball is followed toward its outcome.
Unverified player markers and tactical connectors remain suppressed.

Reaction framing uses Gemini's directly observed face-and-torso `subjectCore`
for one relevant person, not a synthetic centre slice of an oversized box.
Extended arms, legs or teammates need not fit, but the actual cropped preview
must verify the face and torso. Gameplay retains the full initiating-player
and ball checks. Safety margins may reduce at source edges; subjects may not
leave the crop. Version 5 invalidates older framing caches and keeps small
coordinate/error diagnostic JSON in cloud checkpoints (not disposable JPEGs).

Close-up reaction and referee shots additionally require Gemini to return a
real `faceCore` for the same person. The portrait crop follows that observed
face and upper chest when the full body box is wider than 9:16; it never cuts
a synthetic centre slice from a wide box. Gameplay still uses the full player
and ball requirements.

Each observed frame also identifies possession, release, travel, receiving
touch, goalkeeper contact, rebound, loose ball, result or support. Travel and
rebounds do not drag the crop toward an unrelated nearby player. Receiving and
save contact require the involved actor and ball, with matching checks on the
actual preview. Brief occlusions require observed same-shot evidence on both
sides; they cannot bridge a source cut. Source cuts reset camera position.
At most one second of possessed-ball occlusion can be handled using the same
observed actor only when the ball is observed at that actor's feet on both
sides, identity is unchanged and the actual crop review explicitly confirms
the occlusion. No ball coordinates are invented; direct observed coverage is
reported separately. This exception never applies to travel or source cuts.

Verified cache keys use source-content SHA-256, so downloading the same cloud
source again does not invalidate them merely because its filesystem mtime
changed. Failed parallel passes drain active tasks before allowing a retry.

## Capacity

The deployed project already uses `GOOGLE_CLOUD_LOCATION=global`. The request
queue has no default artificial interval between successful calls. When Google
returns 429, the provider cooldown is shared with all queued scene requests.
Jobs retain their scene evidence while waiting and retry automatically.

This is resilience, not reserved Google capacity. Pay-as-you-go shared capacity
can still be busy. Provisioned Throughput is a separate paid commitment and must
not be purchased without approval. See Google's guidance:
https://cloud.google.com/vertex-ai/generative-ai/docs/error-code-429

## Verification

Offline regressions:

```powershell
node --test tests/gemini-framing.test.mjs tests/gemini-request-scheduler.test.mjs
```

Explicit live canary (uses Gemini and is billable; does not deploy or publish):

```powershell
node tests/qa-gemini-framing.mjs SOURCE.mp4 START_SECONDS END_SECONDS EVENT_TYPE
```

Review the generated `cropped.mp4`, model review and saved observations under
`local-data/diagnostics/gemini-framing-canary` before deployment. Offline tests or
a successful API response alone are not proof of correct football tracking.
