# Touchline AI

Touchline AI turns long football footage into a single short vertical analysis/reaction edit. This repository contains a finished interactive product shell plus provider-neutral contracts for the long-running AI/CV/render pipeline.

## What works now

- drag-and-drop MP4, MOV, or WebM selection with local source preview
- all requested edit controls and a 60/65/70/80 second cap
- user-controlled masking for detected logos or watermarks the uploader is authorized to alter
- explicit asynchronous job stages and progress UX
- weighted event scoring, replay deduplication, and duration-aware timeline packing
- editable detected-moment review with timestamps, scores, and commentary
- provider contracts for video understanding, tracking, commentary, and rendering
- safe FFmpeg argument-plan generation for full-screen 1080×1920 output
- downloadable JSON render plan for handing a reviewed edit to a worker

The browser workflow uses deterministic preview moments so the complete interface can be tested without an API key. It does **not** claim those moments came from computer vision, and it does not fabricate a rendered MP4. Connect the processor contracts to real services before production use.

## Architecture

```text
browser upload
  → object storage (source video)
  → durable job record / queue
  → multimodal full-video analyzer
  → moment scorer + deduplicator + 65-second packer
  → ball/player detector and tracker
  → evidence-bound commentary + TTS
  → FFmpeg/OpenCV render worker
  → object storage (one final MP4)
  → result review and download
```

The web request should only create a job. A separate container worker performs FFprobe, model calls, tracking, TTS, and FFmpeg rendering, reporting stage updates to the job store. Source and export bytes belong in object storage; job and moment metadata belong in a relational store.

Key code:

- `app/video-studio.tsx` — upload, settings, processing, and result workflow
- `lib/video/types.ts` — jobs, settings, moments, crop tracks, and stages
- `lib/video/ranking.ts` — scoring, replay dedupe, and duration packing
- `lib/video/providers.ts` — replaceable model/tracker/commentary/render interfaces
- `lib/video/orchestrator.ts` — stage orchestration and useful failures
- `lib/video/render-plan.ts` — selected moments to render segments
- `services/rendering/ffmpeg.ts` — shell-safe FFmpeg argument builder

## Run

Requires Node.js 22.13 or newer.

```bash
npm install
npm run dev
```

Copy `.env.example` to `.env` only when connecting providers. Never put provider keys in client-side variables.

## Production dependencies

- FFmpeg and FFprobe in a long-running container worker
- OpenCV plus a football-capable object detector and multi-object tracker
- an object store supporting resumable/direct uploads
- a durable queue and relational job store
- a configurable multimodal video model (Gemini is one option)
- a TTS provider when AI commentary is enabled

## Known limits

The current site validates the workflow and deterministic ranking/render-plan layer. Real semantic event detection, ball tracking, narration audio, subtitles, and MP4 rendering require the external processor dependencies above. Serverless request handlers are not suitable for 15–20 minute source uploads or multi-minute FFmpeg jobs; use resumable direct uploads and queued container work. Tracking can still fail during rapid camera cuts, occlusion, or low-resolution wide shots, so the worker should fall back to a wider action crop rather than losing the ball.
