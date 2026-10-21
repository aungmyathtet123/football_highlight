# Gemini capacity audit and safe improvements — 2026-10-08

## Endpoint and limits

The processor explicitly configures Vertex AI, project `football-506506`,
global endpoint and Priority PayGo headers. It is not calling the Gemini
Developer API / AI Studio endpoint. Do not apply Developer API Tier 1 RPM,
TPM, RPD or spend-cap tables to this Vertex workload.

Read-only Service Usage quota inspection used project number and the
`v1beta1/consumerQuotaMetrics` API, traversing all pages. No Gemini 3 model or
global-region bucket was returned in the relevant generation/online-prediction
quota entries. This does NOT verify the organization's PayGo baseline, other
project traffic or billing restrictions, and is not proof of unlimited usage.

Earlier Cloud Monitoring project metrics for 06:37:25–08:27:16 UTC recorded
Pro: 12 successful requests, 59 HTTP 429s, 2 HTTP 499s, 2 HTTP 504s;
Flash: 19 successful requests, no HTTP 429s. Peak aligned-minute invocation
counts were Pro 2, Flash 6. All 59 Pro 429 series were priority-downgraded.
These are project/time-window metrics, not complete organization usage or
exact per-job billing. A generic 429 alone does not distinguish shared capacity
from token quota, acceleration limits or another resource restriction.

## Changes

- Per-model admission/cooldown lanes share one actual network concurrency cap.
  A Pro cooldown does not consume Flash's network slots. Successful calls have
  no added request-rate pacing. Provider Retry-After and automatic durable
  retries remain; unlimited concurrent retries are not enabled.
- Model attribution is saved with retry state. A saved Pro cooldown is never
  restored into Flash. Legacy unattributed waits are not assigned to every
  model; any subsequent rejection is persisted with actual model attribution.
- Structured provider QuotaFailure/ErrorInfo fields distinguish explicit quota,
  explicit capacity and unspecified 429s. Generic errors are no longer presented
  as conclusive proof of busy capacity. Only safe identifiers are retained:
  no raw messages, keys, account identifiers, prompt text or video payloads.
- Per-job actual model/request-start minute counters record reported input,
  output, thinking and cached input (a subset, not extra input), and error types.
  Failed requests without usage are not assigned estimated/billed token counts.
  Retain 60 minute buckets per model; counts do not include other applications.
- Previously implemented narration input reductions and source-observation
  deduplication are retained. Full ball/player crop detail and action/goal
  completeness checks are unchanged.
- HTTP/resource classification no longer treats an auth/schema error mentioning
  quota, or a numeric configuration value containing `429`, as a retryable 429.
- The high-thinking video-only finish review now permits 16,384 output tokens
  rather than 8,192. This is a ceiling, not a required output length; the
  visibility, outcome and JSON validation contracts are unchanged.

## Real video-only Flash canary — NOT sufficient to activate all crop routing

Used production `hybridCropReviewRequest`, HIGH native-detail video at 12 FPS,
MEDIUM thinking, same schema, one SDK attempt/request, serial bounded calls.
No job/cache/scene-selection mutation. Saved Pro-approved crops were reference
cases, not infallible ground truth. The canary contained three reference-positive
actions and two deliberately wrong crop/truncated-finish controls.

| Case | Elapsed seconds | Result |
| --- | ---: | --- |
| Awarded goal crop | 62.432 | Accepted |
| Save crop | 36.426 | Accepted; no goal inferred |
| Disallowed header crop | 59.979 | Rejected; disagreement with saved Pro review |
| Wrong-side goal crop | 103.532 | Rejected for absent setup/contact |
| Truncated finish | 15.626 | Rejected for missing outcome |

All five requests succeeded at HTTP level, with zero 429s. All were downgraded
to Standard PayGo (`ON_DEMAND`), despite requesting priority. Aggregate reported
input: 118,159; output: 2,861; thinking: 12,683. Mean elapsed 55.599 seconds.
This is not a full-job benchmark and does not establish general Flash accuracy.

Because a difficult scoring case disagreed, **do not switch all framing reviews
to Flash or silently substitute it after a Pro 429**. Source scoring and actual
crop verification keep their configured Pro model. Existing Flash discovery
and script routing remain unchanged. Diagnostic report:
`work/capacity-crop-flash-20261008/report.json`.

No reserved-throughput purchase, billing change, quota increase, production
deployment, cache deletion or new job is performed as part of this audit.
Google-controlled resource availability cannot be guaranteed by local code.

## Stronger Flash follow-up and current status

Tested the production scene-local phase hints (not claimed outcomes/coordinates)
with HIGH thinking. At the original 8,192 ceiling, the hard header and wrong-side
control both ended at MAX_TOKENS with incomplete JSON; the truncated-finish
control was correctly rejected. No invalid answer was promoted into approval.
A bounded follow-up allowed 16,384 tokens, but the header received a provider
504 after 178.263 seconds. The experimental process was then stopped to avoid
paying for additional controls on a profile that had already failed acceptance.
Those uncompleted controls are not counted as successes. HIGH Flash has not
been enabled as a production crop reviewer.

Verification: **754 JavaScript tests and 118 Python tests passed**. Safely
reloaded only the local processor to activate the input reductions, model lanes,
failure diagnostics and counters. The existing UI job automatically resumed
from its selected scenes. Confirmed in Chrome: all 12 separate clips and seven
approved crops remain. No fresh upload/job, cache removal or manual editing.

The resumed job still receives generic Pro 429s. New persisted records include
the exact model and `kind: unspecified`; no explicit RPM/TPM/daily/spend quota
violation was supplied. This audit has **not eliminated Google's rejections**,
and the current full export is not yet complete. Production is not deployed.

## Primary references

- [Vertex 429 handling](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/deploy/error-code-429)
- [Priority PayGo and downgrade behavior](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/priority-paygo)
- [Developer API rate limits — a different endpoint](https://ai.google.dev/gemini-api/docs/rate-limits)
- [Media-resolution token budgets](https://ai.google.dev/gemini-api/docs/media-resolution)
