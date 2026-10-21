# Local framing test, 9 October 2026

This is an unfinished local canary, not a successful video or production deployment.

## Changes

- Preserve all approved scene cameras and existing selected scene boundaries.
- On unapproved cameras, use a new `initial-v4` observation namespace. Old provider responses remain saved; they are not crop approvals.
- Bound each coordinate answer to 24 observations (3 seconds at 8 fps). The first request sees the whole selected action; subsequent windows include two-sample context overlap without trimming the selected scene.
- Burn a small scene-local clock into the observer's temporary reference video. It does not change source geometry and is not rendered into the final video.
- Preserve directly observed short-window phases. The approximate full-scene timeline is context, not authority to relabel flight as contact or ongoing play as reaction.
- Keep physical-contact consistency, source/crop geometry, and independent actual-crop review checks. No false visibility flags or fabricated ball coordinates are introduced.

## Verification

810 JavaScript tests passed. `npm.cmd run build` passed (exit 0).
Regression tests include actual FFmpeg encoding with unchanged 1920x1080 dimensions and eight frames, exact short-window clocks, complete sample coverage, checkpoint reuse, and protection against coarse timeline phase overwrite.

The existing Netherlands/Germany job `fa69cd20-e456-4e21-8501-8b3e2c216ac8` was resumed through the local UI, not manually approved. Twelve source clips and nine approved crops were retained.
The live provider completed all four observation windows for each of `initial-2-4` and `initial-2-7`. It also returned transient 500, 429 and 504 responses; completed windows survived service failover.

The live run did NOT pass:

- `initial-2-4`: required player/ball geometry did not fit full-bleed portrait at 0.375 seconds. No source boundary was changed or subject box invented to evade it.
- `initial-2-7`: an unverified ball-visibility interval at 2.25 seconds stopped camera verification. The broad timeline incorrectly describing later action also motivated the subsequent context-only phase fix.
- The completed final video does not exist. Job remains attention-required at 35%, with nine of twelve cameras approved. Narration has not started.

After loading the context-only fix, a UI retry reused all eight saved short-window answers without rewatching them through the API. It correctly retained another directly observed contradiction at 6.625 seconds in `initial-2-7` (two claimed contact observations have far-separated actor/ball boxes). This is not solved framing.

The UI monitor previously polled `attention_required` forever, leaving both buttons disabled as “Reconnecting…”. It now exits that saved attention state, shows the cause, and releases the retry busy flag. This was verified through the UI: retry and back-to-studio controls are enabled again. It does not automatically retry negative geometry or approve it.

## Required next decision

The user has been asked whether the blocked Step 1 selections may be replaced with clearer complete source shots, preserving nine approved scenes and every actual goal. Prior instructions lock all Step 2 boundaries; those instructions do not authorize silently removing a goal, trimming a selected action, or rendering an unverified crop. Do not repeatedly retry these saved negatives or claim the automated test count proves video quality.

This short-window approach has not yet demonstrated an end-to-end speed or quality improvement. Do not deploy it as a finished fix before a representative full video passes.
