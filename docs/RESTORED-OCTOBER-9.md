# Approved production checkpoint: 9 October 2026

Main has been restored to the application source behind the user-approved
9 October production images. This is a new fast-forward restoration commit;
history was not rewritten and later branches were not deleted.

## Source provenance

The website and worker source were recovered from the exact generation-pinned
Cloud Build source archives, not reconstructed from the newer local workspace.
The successful builds are:

- Gateway: `e6dcab26-aa44-4915-9d39-f26b15928bad`, image
  `sha256:f2426bac9e181bf4b1691a33d6450ace6afd51d105f0bc11730da59e6eaf4c7c`.
- Worker: `809df101-0aa9-4aa8-a05c-900423a8d175`, image
  `sha256:a73502cdb3a4e1d0989b0a4b0e62293fb67e88e43fb608e55af0bfc31dea7743`.
- Source archive object names, generations and file hashes are in
  `checkpoints/2026-10-09-source.json`.

All 102 recovered processor files also matched the historical worker image.
Application source, UI, assets, lockfile and deployment code are restored;
unrelated baseline development files excluded from both cloud builds remain.
No secrets, private OAuth files, video outputs, caches, virtual environments,
model weights or FFmpeg binaries are committed.

The only supplemental package change is the `test:restore` command. The safe
`.env.example` is aligned with the model/provider choices already running in
the restored deployment. It contains no private credential values. Runtime
model identifiers are the historical configuration, not a claim about future
model availability. Use secret/environment configuration appropriate for the
account running the app.

## Historical behavior

- Original light/green workspace, Original videos, Recap edits and scene queue.
- Default portrait recap and Gemini keyframe profile.
- Three-minute source minimum and 60-second recap requirement.
- Later Accept and continue and later tracking fixes are not restored.

## Verification and limitations

Run `npm ci` and `npm run test:restore` for a production build, byte-level source
verification, Node syntax checks, source eligibility and scene queue/progress
checks. These tests make no Gemini requests and create no cloud jobs.

Tests were not included in either historical cloud build archive. Baseline
repository tests and additional files required by the historical package test
command are retained separately from the authoritative app snapshot. A trial
run of that mixed-version suite passed 250 and failed 33 tests; it is NOT a
clean historical regression suite and `npm test` is not represented as passing.
The restoration-specific tests do not replace a full new-video end-to-end test.
No fresh edited-video test was performed for this source restoration.

Production was already rolled back on 21 October to the images above, with
gateway revision `touchline-gateway-00067-jor` serving 100% of traffic. Its
authenticated website checks and worker startup smoke test passed. This Git
restore does not itself redeploy production or change existing cloud jobs.

The newer uncommitted local workspace is retained on recovery branch
`recovery/local-before-oct09-main-20261021` and in local archive
`work/main-oct09-restore/workspace-before-main/`. That archive is ignored and
must not be published. Git main is checked out separately under
`work/main-oct09-restore/repo/` to avoid overwriting that newer workspace.
