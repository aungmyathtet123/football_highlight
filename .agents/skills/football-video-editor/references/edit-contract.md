# Football analysis edit contract

## Action grammar

Model gameplay as setup, contact, flight or continuation, payoff, and optional reaction. A scene starts before the meaningful movement or touch and ends only after the pass, shot, save, goal, turnover, whistle, or duel resolves.

Before contact, the full-bleed 9:16 crop must contain both the initiating player and football. During flight, the crop begins from that player, leads the ball smoothly, and hands ownership only to a verified receiver, defender, goalkeeper, or goalmouth. A confirmed goal holds the goalmouth and goalkeeper through the visible result. Player-only footage is limited to reaction or celebration after the outcome.

## Camera path

Split at source shot changes before tracking. Prefer a stable virtual camera while required subjects remain inside a safe crop. When movement is necessary, use look-ahead, a dead zone, bounded velocity, bounded acceleration, and temporal smoothing. Never recenter independently on every detection.

Use pitch context and trajectory continuity when initializing or reacquiring the football. Treat detections in stands, advertising, crowd, clothing, or near off-pitch people as unsafe. Preserve the initiating player identity through contact; require sustained evidence before handing to a new player.

## Editorial treatment

Narration explains cause, decision, space, timing, technique, or consequence and must match the visible phase. Captions use short mobile-safe phrases. Highlights remain attached to one involved tracked identity and disappear on uncertainty. Freeze, slow motion, tactical arrows, grades, transitions, sound accents, and event callouts are conditional analytical tools, not automatic decoration.

Use a 0.4–1.0 second freeze only on a verified decision, contact, error, save, or payoff frame and explain that exact evidence during the hold. Use an obviously differentiated analytical or replay grade when it helps separate commentary from normal play, but preserve legibility and do not alternate grades randomly.

## Copyright-aware transformation

Effects do not automatically avoid copyright or establish fair use. Build a genuinely new analytical purpose through original narration, selection, sequencing, reframing, annotations, freezes, and evidence-linked treatment. Use only the source passages reasonably necessary to explain each point and do not make the result a substitute for the original broadcast.

The U.S. Copyright Office explains that fair use is case-specific and considers purpose, nature, amount, and market effect: https://www.copyright.gov/fair-use/more-info.html. YouTube likewise warns that adding original material does not by itself make a use fair: https://support.google.com/youtube/answer/9783148.

## Quality gate

Review the finished video in action order. Reject missing setup/contact/payoff, an absent football, wrong-player ownership, floating annotations, false ball reacquisition, unstable camera motion, unfinished scenes, mismatched narration, cropped captions, random grades, or competing broadcast speech.
