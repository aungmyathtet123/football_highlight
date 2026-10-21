# Source eligibility and saved-step recovery

Original uploads must be at least 180 seconds. The browser checks metadata
before sending a new upload; the processor checks the real media with ffprobe
before enqueueing analysis. Imported local sources receive the same check.
The cloud worker uses this processor validation too. This is an input rule,
not proof that any arbitrary three-minute video contains a complete recap.

Processing exceptions no longer all become PROCESSING_FAILED. The processor
saves its current phase and automatically schedules a retry after the current
queue reservation releases. Waiting timers are restored on processor startup.
Provider/service failures do not exhaust the repair retry allowance.
Existing locked scene boundaries and approved tracking remain reusable.
New tracking repairs use a new observation generation rather than repeating
the same rejected attempt's cache. Final validation still runs.

Invalid sources remain rejected. Missing credentials or incompatible tools
need attention immediately. Three repeated non-service interruptions with no
measurable phase/evidence progress need attention with the exact error saved.
This deliberately avoids an infinite loop or claiming an invalid export works.
An attention job retains its checkpoint and can be retried after repair.
Cloud workers save such jobs before exiting without publishing a nonexistent
MP4; the gateway distinguishes attention from an unexplained worker failure.

These changes require a new production build/deployment. Unit tests do not
replace end-to-end footage review or guarantee every upload succeeds.
