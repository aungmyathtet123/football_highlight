# Google Cloud deployment

Touchline AI runs as two Cloud Run resources in `asia-southeast1`:

- `touchline-gateway` serves the Vinext UI, creates resumable Cloud Storage uploads, exposes durable job status, and launches the worker.
- Authorized YouTube-link imports run in a dedicated worker mode. The worker downloads and validates the source into the same private upload bucket, then stops at `uploaded`/`readyToAnalyze`; it never starts Gemini until the user clicks **Analyze & edit**.
- Cloud-only file-link imports support link-shared Google Drive video files and direct HTTPS MP4/MOV/WebM/MKV links. The worker checks public HTTPS destinations, enforces a 2 GB ceiling, verifies the video stream with FFprobe, remuxes to MP4, then adds a ready-to-edit card. Private Drive files require a different authorized upload method. YouTube links remain best-effort because YouTube may challenge cloud downloaders.
- `touchline-worker` is a Cloud Run Job with 4 vCPU and 16 GiB memory. Each execution downloads one private source, runs the existing processor locally, uploads progress/result objects, and exits.

The bucket `gs://football-506506-touchline` is private and uses uniform bucket-level access. Job status survives browser disconnects. Gemini uses Vertex AI Application Default Credentials; no Gemini API key is copied into either image.

## Build

### Verified deployment — October 5, 2026

The worker uses `worker:compact-header-20261005` (immutable digest
`sha256:1dbc7c3a565438aa9ab9c08776d775e1465185ec65edea3ad22127f50a65d7f6`).
The approved portrait header is a compact, centered team-image–score–team-image
group without team-name text or a footer. The blurred backdrop and gameplay
timing are unchanged. Two-digit scores reserve additional space only as needed.
FotMob identity assets and reviewed official alternatives are packaged in the image.

The gateway image `gateway:compact-header-20261005` has immutable digest
`sha256:620856dad661209053fbf10b99f19bb52c349110f95bb98f33221f6094ae29bb`.
Revision `touchline-gateway-00038-52q` serves 100% of traffic. Node fetch's decoded
web responses no longer forward stale compression/length headers to browsers.
Updating an image does not necessarily move pinned traffic: inspect the actual
traffic revision and use `gcloud run services update-traffic` after readiness checks.

Verification: 488 JavaScript tests and the local application build passed. The
worker image's Linux presentation render passed using the configured server font
and packaged team images (`cloudbuild.presentation-smoke.yaml`). Live authenticated
health/UI responses returned 200; compressed page requests had correct response
headers. This was a presentation/deployment check, not a new whole-match cloud job.

Old application job records, finished outputs and retry caches were cleared.
The private application bucket contained only preserved YouTube connection data
after cleanup; no Cloud Run worker execution was active. Local generated artifacts
were moved to the Windows Recycle Bin, while source uploads, Downloads originals,
code, credentials and settings were preserved. Application-bucket soft-deleted
objects retain the existing seven-day recovery window. New uploads use the updated
worker; old preview URLs no longer resolve after the requested cleanup.

```powershell
gcloud builds submit . --project=football-506506 --config=deploy/cloud-run/cloudbuild.worker.yaml --ignore-file=deploy/cloud-run/gcloudignore.worker --substitutions=_IMAGE=asia-southeast1-docker.pkg.dev/football-506506/touchline-ai/worker:latest
gcloud builds submit . --project=football-506506 --config=deploy/cloud-run/cloudbuild.gateway.yaml --ignore-file=deploy/cloud-run/gcloudignore.gateway --substitutions=_IMAGE=asia-southeast1-docker.pkg.dev/football-506506/touchline-ai/gateway:latest
```

## Reliability contract

### Source incident ownership (October 5, 2026)

Discovery search windows overlap intentionally, but they must not define goal
identity. Live incidents are bound using observed payoff/contact source clocks
and non-overlapping score-transition ownership windows. A setup that begins
before the preceding score sample cannot merge a later finish into that earlier
goal. Replays inherit their observed live action, not the scorebug displayed
during the replay. Ambiguous unobserved intervals remain unverified; genuine
missing goals are not silently accepted.

Step 1 independently verifies and locks one same-incident backup for required
goals when the source supplies it. Both views may be probed for portrait framing,
but only one approved view enters the finished recap and only one counts toward
source capacity. A difficult crop cannot force rediscovery of the whole match
or silently erase a goal merely because the easiest view was deferred.

Semantic, recovery-discovery and primary outcome cache keys use the source's
content fingerprint rather than the new download modification time. Restoring
identical cloud bytes must not discard completed observations; changed content,
scene boundaries, model and context still invalidate the corresponding evidence.

The shared binding policy is applied before clear-angle ranking and is
idempotent on retries. It can undo an obsolete duplicate-view rejection only
when the independently verified scene has been rebound to a different incident;
it cannot undo a failed semantic observation. Production match/player research
still uses Gemini's Google Search grounding and independent report verification,
without operator-supplied fixture facts.

Active cloud snapshots clear stale failures from earlier attempts while retaining
the source and durable checkpoint pointers. Worker image overlays install the
current locked Node dependencies and run the real processor startup/health test
inside Linux before deployment. Automated regression tests cover consecutive
goals, overlapping setups, replay ownership, ambiguous clocks, real missing
coverage, and cloud status recovery. Full-video production verification remains
a separate required check; these tests alone do not certify an edited export.

### Optional Gemini Priority PayGo

After approving the higher per-token cost, set `GEMINI_TRAFFIC_TIER=priority`
and `GEMINI_PRIORITY_LOCATION=us` on the worker. Only Gemini generation moves;
storage, TTS and the Cloud Run region are unchanged. The client requests shared
Priority PayGo with Google's two documented headers. Logs report the response's
actual `trafficType`: `ON_DEMAND_PRIORITY` confirms priority; `ON_DEMAND` means
Google served standard traffic instead. Do not treat a successful request as
proof of priority. Existing checkpoint/retry behavior remains necessary.

On October 1, 2026, a small REST request and an SDK request for this project's
`gemini-3.7-flash` both verified priority on `us`; `global` returned standard.
This is a point-in-time test, not a guarantee for future video workloads.
See [Google's Priority PayGo documentation](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/priority-paygo).

- A browser may call `start` only once for a newly uploaded job. GCS generation preconditions reject racing or duplicate requests.
- Semantic or tracking shortfalls use the processor's saved-job recovery endpoint inside the same worker, preserving the scene inventory and local tracking cache.
- The worker snapshots the local job record, Gemini caches, scene manifests, narration assets, render prerequisites, and this job's tracking scene files plus a transactionally consistent SQLite observation snapshot to versioned `checkpoints/<job-id>/` archives. A replacement worker restores the latest committed archive before calling the local retry endpoint, without re-detecting already saved frames.
- Checkpoint publication is atomic: the cloud job record references a new archive only after that archive has uploaded successfully. A failed snapshot leaves the previous recovery point active.
- Browser upload, worker download, and checkpoint restoration are separate UI states. Closing the browser never stops a healthy Cloud Run execution.
- Cloud Run uses up to 10 automatic task retries. Retry attempts restore the latest durable checkpoint using `CLOUD_RUN_TASK_ATTEMPT`, including when the original execution was started as a new upload. They reuse the saved source and selected scenes.
- Every two minutes the worker saves a checkpoint even if the displayed stage percentage has not changed. Successful Gemini observation batches are stored outside disposable image directories and restored with the checkpoint.
- After 100 minutes a worker saves its work and requests an automatic Cloud Run retry before the two-hour task timeout. The dashboard remains in processing while Cloud Run continues the execution. This is a bounded retry policy; sustained provider unavailability can still exhaust the retry budget.
- The worker records every stage transition in `jobs/<id>.json`; the final MP4 is stored at `outputs/<id>/final.mp4`.
- Cloud Storage limits repeated replacement of one job-status object to about once per second. Import progress writes are time-throttled, serialized, and retried with exponential backoff for transient 429/5xx responses.
- Google capacity responses remain non-fatal and use the processor's persistent exponential backoff.

## Project history and retention

- `GET /jobs` is the durable dashboard source of truth. It lists working, failed, and completed projects from Cloud Storage so history survives browser refreshes and device changes.
- Failed jobs remain retryable for 14 days when the dashboard is active. Manual deletion is available only after a job completes or fails.
- Original source uploads and processing checkpoints have a 14-day Cloud Storage lifecycle ceiling. Unpublished finished MP4 files have the same ceiling; the small job record remains available for history.
- A verified YouTube upload calls `POST /jobs/:id/published`. The gateway marks both stored media objects with publication time, after which Cloud Storage deletes the source after one day and the finished output after seven days.
- `deploy/cloud-run/storage-lifecycle.json` owns the provider-side deletion rules, so published-media cleanup does not depend on a browser remaining online.

## Private verification

The gateway is initially deployed without unauthenticated invocation. Verify it using an identity token before granting public invocation to the application-password-protected revision.

```powershell
$touchlineIdentity = gcloud auth print-identity-token
curl.exe -H "Authorization: Bearer $touchlineIdentity" https://touchline-gateway-793575411744.asia-southeast1.run.app/health
```

Never commit `.env`, OAuth client files, refresh tokens, access passwords, or session secrets.
