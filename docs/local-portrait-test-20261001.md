# Local portrait test: 2026-10-01

Status: **not approved for export or production deployment**.

Source: `Netherlands vs Germany Highlights [cvaMuxrK_8I].mp4`.
Fresh job: `c0b55370-f426-4dba-9fa8-f4db2a5039ef`.
Evidence directory: `work/local-e2e-1790831749363`.

Confirmed fixes and checks:

- Structured scene reviews require exact IDs, boolean verdicts, and the expected batch count.
- Valid partial scene reviews are saved; corrections request only missing IDs.
- A demonstrated concatenated-reel clock slip is converted before source-time normalization. Both origin-at-reel-boundary and an out-of-range action time are required; ordinary local times are not reinterpreted.
- Detailed outcome observation also reviews saves and misses, rather than only scenes already labelled as goals.
- Restored workers honor a saved provider cooldown before issuing requests.
- 291 JavaScript tests pass. The application build passed before the final processor-only changes; processor syntax checks pass afterward.

Remaining blocking evidence:

- Gemini 3.1 Pro described the 176.00–180.56 source passage as a goal. Original source and encoded proxy filmstrips show the same non-scoring passage; this is not a proxy mix-up.
- A separate neutral live comparison on that exact proxy and two enlarged original frames also returned a goal (18.239 seconds, 7,087 input tokens). Its description asserted a ball in the net not supported by the reviewed action.
- The 224.42–233.16 passage also generated conflicting goal claims. The official DFB report describes the corresponding 65th-minute opportunity as a miss.
- Whole-video analysis and compact semantic reels have misclassified actual goals, reactions, and refereeing decisions. Native-image checks recover some mistakes but are not a reliable sole acceptance authority.
- Priority was requested, but most complete-job responses reported `ON_DEMAND`, not confirmed priority capacity. Temporary capacity/service waits persisted without failing the job.

The scoped local harness and processor were stopped to avoid further invalid recovery work. Uploaded source, seven completed semantic batches, native images, outcome responses, and logs remain saved. No final MP4 was approved or uploaded. No new changes were deployed to production.

Next architecture decision requires user agreement: retain Gemini for scene/story understanding and narration, but use a football-specific detector and temporal tracker for observable ball/player evidence, followed by source and rendered-crop QA. This changes the earlier Gemini-only tracking constraint; do not introduce it silently or claim a package guarantees flawless tracking.

References:

- https://www.dfb.de/news/first-germany-game-under-klopp-ends-in-draw
- https://github.com/roboflow/sports
