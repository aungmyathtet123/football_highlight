---
name: football-video-editor
description: Plan, implement, or review vertical football-analysis videos where scene completion, ball/player continuity, tactical narration, and stable 9:16 reframing matter.
---

# Football Video Editor

Treat football editing as a semantic directing task followed by deterministic tracking and rendering. Read [the edit contract](references/edit-contract.md) before changing analysis prompts, tracking, camera paths, highlights, narration alignment, or final video quality checks.

Keep the roles separate:

- Gemini or another multimodal model understands the complete source, identifies the analytical story, and emits action phases plus an edit-decision list.
- A high-frame-rate local vision pipeline detects and tracks the football and player identities, verifies joint visibility, and computes a constrained smooth crop path.
- FFmpeg renders only verified timing, tracking, effects, captions, narration, and sound instructions.

Do not use sparse multimodal-model timestamps as per-frame coordinates. Do not repair missing football evidence by padding, random player framing, or an unverified marker. Validate observable behavior with representative footage and preserve user-selected duration, aspect ratio, audio, and styling settings.

Do not promise copyright avoidance. Editing effects, cropping, color changes, captions, or attribution do not automatically establish fair use. When the user is relying on criticism or commentary, make every source excerpt and editorial device necessary to a concrete analytical point, use no more source footage than that point reasonably needs, replace rather than compete with broadcast commentary, and avoid making a substitute for the original program.
