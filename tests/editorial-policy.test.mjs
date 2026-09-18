import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import {
  MIN_SCENE_SECONDS,
  MAX_SCENE_SECONDS,
  COMPLETE_ACTION_SECONDS,
  COMPLETE_HIGHLIGHT_MAX_PLAYBACK_RATE,
  completeActionPlaybackRate,
  analysisFirstIncidentOrder,
  assessPlannedSceneTracking,
  assignContentBeatsToMoments,
  buildContentWritingPrompt,
  buildContinuousNarration,
  buildEvidenceAlignmentPrompt,
  buildWholeVideoDirectorPrompt,
  contentPlanProblems,
  contentEvidenceBindingProblems,
  editableEvidenceDuration,
  expandVerifiedTimeline,
  fitContentPlanToEvidenceSlots,
  fitSegmentPlaybackToDuration,
  highlightSequenceProblems,
  highlightStoryDeficiencies,
  chooseTrackedIncidentAngles,
  limitIncidentActionViews,
  keyframePhaseProblems,
  normalizeContentPlan,
  plannedSegmentDuration,
  rankSemanticBackups,
  selectDirectorCandidates,
  semanticBackupScore,
  splitCaptionChunks,
  strongestStoryCandidates,
} from "../local-processor/editorial-policy.mjs";
import { commentaryPrompt } from "../local-processor/google-cloud-tts.mjs";
import { activePlayerOverlayFrames, analysisAnnotationForMoment, analysisOverlayWindow, editorialGrade, effectiveOverlayMasks, naturalEditorialGradeFilters, nativePayoffWindow, sceneEntryTransition, sourceMaskFilters, synchronizationProblems, verifiedPlayerLabel } from "../local-processor/render-video-v2.mjs";
import { adaptiveHighlightDurationBounds, automaticDurationSettings, automaticStoryPrompt, validateAutomaticStory } from "../local-processor/automatic-duration.mjs";
import { captionAss, conciseCaption, normalizeCaptionHeadline, sparseCaptionCues, shortReactionCandidates, obviousIdentityProblems, unverifiedNamedEntities } from "../local-processor/short-form-policy.mjs";
import { bindVerifiedIdentitiesToIncidents, claimedResearchSources, discoverVerifiedResearchSources, identityBindingProblems, matchReportPageSupports, matchResearchPrompt, normalizeMatchContext, scoreClaimIsVerified, verifiedIdentityNames, verifyClaimedResearchSources } from "../local-processor/match-research.mjs";
import {
  FOOTBALL_EDITOR_SKILL_VERSION,
  expandMomentToReviewedAction,
  footballObservationContract,
  normalizeReviewedTrackingBrief,
  normalizeTrackingBrief,
} from "../local-processor/football-editor-skill.mjs";

test("analysis-first ordering ranks incident chapters but preserves live, replay, reaction", () => {
  const moments = [
    { id: "early-live", storyId: "early", startTime: 10, importanceScore: 0.5, hookScore: 0.4, storyPhase: "action" },
    { id: "late-reaction", storyId: "late", startTime: 95, importanceScore: 0.9, hookScore: 0.8, storyPhase: "reaction", eventType: "celebration" },
    { id: "late-replay", storyId: "late", startTime: 90, importanceScore: 0.9, hookScore: 0.8, storyPhase: "replay", isReplay: true },
    { id: "late-live", storyId: "late", startTime: 80, importanceScore: 0.95, hookScore: 1, storyPhase: "action" },
    { id: "early-reaction", storyId: "early", startTime: 18, importanceScore: 0.5, hookScore: 0.4, storyPhase: "reaction", eventType: "celebration" },
  ];
  assert.deepEqual(analysisFirstIncidentOrder(moments).map((moment) => moment.id), [
    "late-live", "late-replay", "late-reaction", "early-live", "early-reaction",
  ]);
});

test("football editor skill emits a normalized phase and camera contract", () => {
  const contract = footballObservationContract();
  assert.match(contract, /setup, initiating player, decisive contact, ball flight/i);
  assert.match(contract, /trackingBrief/i);
  const brief = normalizeTrackingBrief({
    contactTime: 3,
    flightStartTime: 3.2,
    handoffTime: 4,
    payoffStartTime: 5.5,
    payoffEndTime: 6.8,
    attackDirection: "right",
    cameraMode: "goal_hold",
    payoffTarget: "goal_mouth",
    goalFocusX: 0.82,
  }, { eventType: "goal" }, 100, 108, 100);
  assert.equal(FOOTBALL_EDITOR_SKILL_VERSION, 12);
  assert.equal(brief.contactTime, 103);
  assert.equal(brief.handoffTime, 104);
  assert.equal(brief.payoffStartTime, 105.5);
  assert.equal(brief.goalFocusX, 0.82);
  assert.deepEqual(brief.requiredSubjectsByPhase[0].subjects, ["ball", "initiating_player"]);
  assert.equal(brief.primaryPlayerRole, "scorer");
  const reconciled = normalizeTrackingBrief({
    goalFocusX: .85,
    payoffEvidence: {verified:true,eventType:"goal",startTime:4,endTime:5,targetBox:[.42,.6,.62,.88]},
  }, {eventType:"goal"}, 0, 6);
  assert.equal(reconciled.goalFocusX, .52);
  const directionCorrected = normalizeTrackingBrief({
    attackDirection: "right", goalFocusX: .88,
    payoffEvidence: {verified:true,eventType:"goal",startTime:4,endTime:5,targetBox:[.12,.52,.38,.8]},
  }, {eventType:"goal"}, 0, 6);
  assert.deepEqual(directionCorrected.payoffEvidence.targetBox, [.62,.52,.88,.8]);
  assert.equal(directionCorrected.goalFocusX, .75);
  const merged = normalizeReviewedTrackingBrief({
    trackingBrief: {goalFocusX:.82},
    payoffEvidence: {verified:true,eventType:"goal",startTime:3,endTime:4,targetBox:[.38,.58,.56,.94]},
  }, {eventType:"goal",startTime:0,endTime:6,trackingBrief:{}}, "goal");
  assert.equal(merged.goalFocusX, .47);
  assert.deepEqual(merged.payoffEvidence.targetBox, [.38,.58,.56,.94]);
  const cached = normalizeTrackingBrief({
    goalFocusX:.82,
    contactTime:318.7,
    payoffEvidence:{verified:true,eventType:"goal",startTime:319.2,endTime:321.2,targetBox:[.38,.58,.56,.94]},
  }, {eventType:"goal"}, 316, 321.667);
  assert.equal(cached.contactTime, 318.7);
  assert.equal(cached.goalFocusX, .47);
  const preservedAbsolute = normalizeReviewedTrackingBrief({}, {
    eventType: "goal", startTime: 31.84, endTime: 45.65,
    trackingBrief: {
      originTime: 33.04, contactTime: 42.1, flightStartTime: 42.2,
      handoffTime: 42.6, payoffStartTime: 43, payoffEndTime: 44.5,
      payoffEvidence: {verified:true,eventType:"goal",startTime:43,endTime:44.5,targetBox:[.65,.25,.95,.75]},
    },
  }, "goal");
  assert.equal(preservedAbsolute.originTime, 33.04);
  assert.equal(preservedAbsolute.contactTime, 42.1);
  assert.equal(preservedAbsolute.payoffEndTime, 44.5);
  assert.deepEqual(preservedAbsolute.payoffEvidence.targetBox, [.65,.25,.95,.75]);
});

test("semantic review extends a clipped goal through scorer contact and payoff", () => {
  const moment = { id:"goal", eventType:"goal", startTime:312, endTime:315.65,
    selectedForFinalVideo:true, trackingDecision:"incomplete_goal_action" };
  const review = { trackingBrief:{ contactTime:7.1, flightStartTime:7.2,
    handoffTime:7.45, payoffStartTime:7.6, payoffEndTime:8.35 },
    payoffEvidence:{ verified:true, startTime:7.6, endTime:8.35, targetBox:[.4,.3,.6,.7] } };
  const expanded = expandMomentToReviewedAction(moment, review, "goal", 326.32);
  assert.equal(expanded.endTime, 321.15);
  assert.equal(expanded.selectedForFinalVideo, false);
  assert.equal(expanded.trackingDecision, undefined);
  assert.equal(expanded.boundaryCorrection.reason, "extended_through_reviewed_contact_flight_and_payoff");
  const brief = normalizeReviewedTrackingBrief(review, expanded, "goal");
  assert.equal(brief.contactTime, 319.1);
  assert.equal(brief.payoffEndTime, 320.35);
});

test("semantic boundary expansion never consumes footage outside its review window", () => {
  const moment = { eventType:"goal", startTime:10, endTime:14 };
  const review = { trackingBrief:{ contactTime:5, payoffEndTime:20 } };
  assert.equal(expandMomentToReviewedAction(moment, review, "goal", 17).endTime, 17);
});

test("whole-video director prompt enforces the requested editorial flow", () => {
  const prompt = buildWholeVideoDirectorPrompt({
    sourceDuration: 540,
    targetDuration: 60,
    intensity: "dynamic",
    commentary: true,
  });
  assert.match(prompt, /complete 540\.00-second source from beginning to end/i);
  assert.match(prompt, /exactly one analytical question/i);
  assert.match(prompt, /one incident\/storyId/i);
  assert.match(prompt, /preserve the configured output frame/i);
  assert.match(prompt, /every source excerpt must be necessary/i);
  assert.match(prompt, /continuous male analyst narration/i);


  assert.equal(MIN_SCENE_SECONDS, 0.5);
  assert.equal(MAX_SCENE_SECONDS, 30);
  assert.equal(COMPLETE_ACTION_SECONDS, 5);
  assert.equal(COMPLETE_HIGHLIGHT_MAX_PLAYBACK_RATE, 1);
  assert.match(prompt, /complete action chain/i);
  assert.match(prompt, /normal 1\.0x speed/i);
  assert.match(prompt, /cutting before the result/i);
});

test("complete actions keep their source boundaries and never exceed the natural speed ceiling", () => {
  assert.equal(completeActionPlaybackRate(4, 0), 1);
  assert.equal(completeActionPlaybackRate(10, 0), 1);
  const longRate = completeActionPlaybackRate(22.16, 0.82);
  assert.equal(longRate, COMPLETE_HIGHLIGHT_MAX_PLAYBACK_RATE);
  assert.ok(22.16 / longRate + 0.82 > COMPLETE_ACTION_SECONDS);
  const policy = readFileSync(new URL("../local-processor/editorial-policy.mjs", import.meta.url), "utf8");
  const server = readFileSync(new URL("../local-processor/server.mjs", import.meta.url), "utf8");
  assert.match(policy, /if \(moment\.completeActionCompressed\) continue/);
  assert.match(server, /repairPass < planned\.length/);
  assert.match(server, /repairPass < orderedSavedMoments\.length/);
  assert.match(server, /playbackRate: completeActionRate\(analyticalFreeze \? 0\.72 : 0\)/);
});

test("analysis beats receive semantic grades and non-overlapping entry treatments", () => {
  assert.equal(editorialGrade({ role: "setup" }), "cool");
  assert.equal(editorialGrade({ role: "action" }), "dramatic");
  assert.equal(editorialGrade({ isReplay: true, eventType: "goal" }), "replay_blue");
  assert.equal(editorialGrade({ eventType: "goal", storyPhase: "action" }), "goal_gold");
  assert.equal(editorialGrade({ storyPhase: "reaction" }), "warm");
  assert.deepEqual(sceneEntryTransition({ transitionIn: "cut" }, 0, 4), { kind: "cut", duration: 0, filter: "" });
  const replayEntry = sceneEntryTransition({ isReplay: true, transitionDuration: 0.12 }, 1, 4);
  assert.equal(replayEntry.kind, "white");
  assert.match(replayEntry.filter, /fade=t=in:st=0:d=0\.120:color=white/);
  const setupEntry = sceneEntryTransition({ role: "setup", transitionDuration: 0.14 }, 2, 4);
  assert.equal(setupEntry.kind, "black");
  assert.match(setupEntry.filter, /color=black/);
  const nativePayoff = nativePayoffWindow({
    trackingDecision: "native_frame_verified_goal",
    startTime: 100,
    trackingBrief: { payoffStartTime: 104.2, payoffEndTime: 105.4 },
  }, 8);
  assert.ok(Math.abs(nativePayoff.start - 4.2) < 1e-9);
  assert.ok(Math.abs(nativePayoff.end - 5.4) < 1e-9);
  assert.equal(nativePayoffWindow({ trackingDecision: "unverified" }, 8), null);
});

test("every scene grade has a stronger natural exposure treatment without monochrome conversion", () => {
  for (const grade of ["clean", "cool", "warm", "dramatic", "goal_gold", "replay_blue"]) {
    const filters = naturalEditorialGradeFilters(grade);
    assert.ok(filters[0].startsWith("eq=saturation="));
    assert.ok(filters[0].includes("contrast="));
    assert.ok(filters[0].includes("brightness="));
    assert.equal(filters.some((filter) => filter.includes("hue=s=0")), false);
  }
  const renderer = readFileSync(new URL("../local-processor/render-video-v2.mjs", import.meta.url), "utf8");
  assert.match(renderer, /filters\.push\("vignette=PI\/18"\)/);
});

test("complete-highlight selection minimizes broadcast usage before adding lower-value chances", () => {
  const server = readFileSync(new URL("../local-processor/server.mjs", import.meta.url), "utf8");
  const renderer = readFileSync(new URL("../local-processor/render-video-v2.mjs", import.meta.url), "utf8");
  const policy = readFileSync(new URL("../local-processor/editorial-policy.mjs", import.meta.url), "utf8");
  assert.match(server, /minimum \+ Math\.min\(8, Math\.max\(4, minimum \* 0\.10\)\)/);
  assert.match(server, /save: 5, shot_on_target: 5, big_chance: 4, shot_off_target: 2/);
  assert.match(server, /completeActionRate\(freezeEligible \? 0\.82 : 0\)/);
  assert.match(server, /compressedCapacity/);
  assert.match(server, /completeActionCompressed: !isReaction/);
  assert.match(renderer, /playbackRateUpper\(moment\)/);
  assert.match(renderer, /complete_highlights" \? 1\.6/);
  assert.match(policy, /Pure play-by-play.*is invalid/);
});

test("director candidate selection considers strong moments from the end of a long video", () => {
  const candidates = Array.from({ length: 220 }, (_, index) => ({
    id: "candidate-" + index,
    startTime: index * 2,
    importanceScore: index === 219 ? 100 : 50,
    confidence: 0.8,
    keepDecision: "keep",
  }));
  const selected = selectDirectorCandidates(candidates, 180);
  assert.equal(selected.length, 180);
  assert.ok(selected.some((candidate) => candidate.id === "candidate-219"));
  assert.deepEqual(selected, [...selected].sort((a, b) => a.startTime - b.startTime));
});

test("deterministic fallback chooses a complete story instead of unrelated highlights", () => {
  const candidates = [
    { id: "solo", storyId: "unrelated", storyPhase: "payoff", importanceScore: 99, ballVisible: true, mainPlayerVisible: true },
    { id: "a", storyId: "incident", storyPhase: "build_up", importanceScore: 82, ballVisible: true, mainPlayerVisible: true },
    { id: "b", storyId: "incident", storyPhase: "action", importanceScore: 84, ballVisible: true, mainPlayerVisible: true },
    { id: "c", storyId: "incident", storyPhase: "payoff", importanceScore: 88, ballVisible: true, mainPlayerVisible: true },
    { id: "d", storyId: "incident", storyPhase: "replay", importanceScore: 80, ballVisible: true, mainPlayerVisible: true },
    { id: "e", storyId: "incident", storyPhase: "reaction", importanceScore: 76, ballVisible: false, mainPlayerVisible: true },
  ];
  assert.deepEqual(strongestStoryCandidates(candidates).map((candidate) => candidate.id), ["a", "b", "c", "d", "e"]);
});

test("continuous narration follows edit order and remains sentence based", () => {
  const narration = buildContinuousNarration([
    { selectedForFinalVideo: true, editOrder: 1, commentary: "That movement opens the space" },
    { selectedForFinalVideo: false, editOrder: 2, commentary: "Do not include this" },
    { selectedForFinalVideo: true, editOrder: 0, commentary: "Watch the defender step forward." },
  ]);
  assert.equal(narration, "Watch the defender step forward. That movement opens the space.");
});

test("captions are short and stay inside the mobile safe width", () => {
  const chunks = splitCaptionChunks("Watch the defender step forward because that movement opens the space.", 3, 18);
  assert.ok(chunks.length >= 4);
  assert.ok(chunks.every((chunk) => chunk.split(/\s+/).length <= 3));
  assert.ok(chunks.every((chunk) => chunk.length <= 18 || !chunk.includes(" ")));
  assert.equal(chunks.join(" "), "Watch the defender step forward because that movement opens the space.");
  assert.deepEqual(
    splitCaptionChunks("resistance through sharp vertical movement creates the opening"),
    ["resistance through", "sharp vertical", "movement creates", "the opening"],
  );
});

test("TTS direction requests an energetic male recap presenter rather than documentary delivery", () => {
  const exampleEnvironment = readFileSync(new URL("../.env.example", import.meta.url), "utf8");
  assert.match(commentaryPrompt, /energetic adult male football recap announcer/i);
  assert.match(commentaryPrompt, /never sound like a calm documentary/i);
  assert.match(commentaryPrompt, /165 to 175 words per minute/i);
  assert.match(commentaryPrompt, /never scream and never imitate live play-by-play/i);
  assert.match(exampleEnvironment, /TTS_MODEL=gemini-2\.5-pro-tts/);
  assert.match(exampleEnvironment, /TTS_VOICE=Fenrir/);
});

test("complete recap scripts reject slow documentary filler", () => {
  const plan = normalizeContentPlan({ title:"Five Words Make A Valid Title", editorialThesis:"Wide play", storyQuestion:"Why?", storyAnswer:"Movement.",
    contentBeats:[{beatId:"one",role:"hook",narration:("The response arrives with pressure. ").repeat(60),evidenceNeed:"goal",captionText:"BIG MOMENT"}] }, 60);
  assert.ok(contentPlanProblems(plan, 60, 1, 1, "requested", true).includes("slow_documentary_filler"));
});
test("complete recap rejects reaction descriptions and unverified match outcomes", () => {
  const plan = {
    title: "How Four Goals Changed Everything",
    editorialThesis: "Wide attacks created the openings.",
    storyQuestion: "How were the openings made?",
    storyAnswer: "Width and timing created them.",
    contentScript: "The forward crosses his arms. Pumping his fists follows. Gathering the ball immediately from the net seals a deserved attacking triumph.",
    contentBeats: [{ beatId: "beat-1", role: "analysis", narration: "The forward crosses his arms. Pumping his fists follows. Gathering the ball immediately from the net seals a deserved attacking triumph.", captionText: "DECISIVE PRESSURE" }],
  };
  const problems = contentPlanProblems(plan, 5, 1, 1, "requested", true, { status: "unverified" });
  assert.ok(problems.includes("reaction_description_as_analysis"));
  assert.ok(problems.includes("unverified_match_outcome_claim"));
});

test("deterministic recap alignment preserves exact evidence ids across replays", () => {
  const moments = [
    { id: "live-one", eventType: "goal", storyPhase: "action" },
    { id: "replay-one", eventType: "goal", storyPhase: "replay", isReplay: true },
    { id: "reaction-one", eventType: "celebration", storyPhase: "reaction" },
    { id: "live-two", eventType: "goal", storyPhase: "action" },
  ];
  const beats = [
    { beatId: "beat-live-one", evidenceNeed: "live-one", narration: "First incident." },
    { beatId: "beat-live-two", evidenceNeed: "live-two", narration: "Second incident." },
    { beatId: "beat-replay-one", evidenceNeed: "replay-one", narration: "Analysis of the first incident." },
  ];
  const assignments = assignContentBeatsToMoments(beats, moments);
  assert.equal(assignments.get("live-one")?.beatId, "beat-live-one");
  assert.equal(assignments.get("replay-one")?.beatId, "beat-replay-one");
  assert.equal(assignments.get("live-two")?.beatId, "beat-live-two");
  assert.equal(assignments.has("reaction-one"), false);
});

test("narration is never reassigned when its exact tracked scene is absent", () => {
  const moments = [
    { id: "goal-one", eventType: "goal", storyPhase: "action" },
    { id: "chance-two", eventType: "shot_on_target", storyPhase: "action" },
  ];
  const assignments = assignContentBeatsToMoments([
    { beatId: "beat-missing-save", evidenceNeed: "save-three", narration: "A fingertip save protects the result." },
    { beatId: "beat-goal", evidenceNeed: "goal-one", narration: "The finish punishes the exposed space." },
  ], moments);
  assert.equal(assignments.get("goal-one")?.beatId, "beat-goal");
  assert.equal(assignments.has("chance-two"), false);
  assert.equal([...assignments.values()].some((beat) => beat.beatId === "beat-missing-save"), false);
});

test("recap writing requires one unique exact candidate id per narration beat", () => {
  const moments = [{ id: "gemini-1" }, { id: "gemini-2" }];
  assert.deepEqual(contentEvidenceBindingProblems([
    { beatId: "beat-1", evidenceNeed: "gemini-1" },
    { beatId: "beat-2", evidenceNeed: "gemini-2" },
  ], moments), []);
  assert.deepEqual(contentEvidenceBindingProblems([
    { beatId: "beat-1", evidenceNeed: "A descriptive request" },
    { beatId: "beat-2", evidenceNeed: "gemini-1" },
    { beatId: "beat-3", evidenceNeed: "gemini-1" },
  ], moments), [
    "evidenceNeed_must_be_exact_candidate_id:beat-1",
    "evidenceNeed_candidate_id_reused:gemini-1",
  ]);
});

test("retry narration uses exact evidence only and has no stale or nearest-scene fallback", () => {
  const server = readFileSync(new URL("../local-processor/server.mjs", import.meta.url), "utf8");
  const functionStart = server.indexOf("function applyNarrationToLockedVisualTimeline");
  const exactBinding = server.indexOf("assignContentBeatsToMoments(beats, selected)", functionStart);
  const functionEnd = server.indexOf("function buildDeterministicEditPlan", functionStart);
  const implementation = server.slice(functionStart, functionEnd);
  assert.ok(functionStart >= 0);
  assert.ok(exactBinding > functionStart);
  assert.equal(implementation.includes("beatsById.get(String(moment?.beatId"), false);
  assert.equal(implementation.includes("const remainingBeats"), false);
  assert.equal(implementation.includes("assignment.set(String(chosen.id)"), false);
});

test("phase verification follows a shot after the initiating player leaves the crop", () => {
  assert.deepEqual(assessPlannedSceneTracking({eventType:"goal",storyPhase:"reaction",role:"reaction"},null),
    {usable:false,mode:"missing_tracking"});
  const phase = { samples:10, jointCoverage:.9, directJointCoverage:.8, directBallCoverage:.8, ballCoverage:.95 };
  const evidence = { phaseEvidence:{version:1,setup:phase,contact:phase,flight:phase,payoff:phase},
    goalActionComplete:true, goalPayoffCoverage:.8, jointFitCoverage:.45, maxDirectBallGap:.4,
    cameraMaxStep:.03, cameraStepP95:.02, cameraJerkP95:.01 };
  const moment = {eventType:"goal",confidence:1,actionComplete:true,ballVisible:true,mainPlayerVisible:true};
  assert.deepEqual(assessPlannedSceneTracking(moment,evidence),{usable:true,mode:"phase_verified_goal"});
  assert.deepEqual(assessPlannedSceneTracking({...moment,eventType:"shot_on_target"},evidence),{usable:true,mode:"phase_verified_action"});
  for (const key of ["contact","flight"]) {
    const missing = {...evidence,phaseEvidence:{...evidence.phaseEvidence,[key]:{...phase,directJointCoverage:0,directBallCoverage:0}}};
    assert.deepEqual(assessPlannedSceneTracking(moment,missing),{usable:false,mode:"incomplete_goal_action"});
  }
  assert.deepEqual(assessPlannedSceneTracking(moment,{...evidence,cameraMaxStep:.12}),{usable:false,mode:"unstable_camera"});
});

test("keyframe phases lock player and ball, then follow flight and payoff", () => {
  const frames = [
    ...Array.from({ length: 5 }, () => ({ actionPhase: "setup", directBall: true, ballInFrame: true, jointFit: true, markerVisible: 1 })),
    ...Array.from({ length: 3 }, () => ({ actionPhase: "contact", directBall: true, ballInFrame: true, jointFit: true, markerVisible: 1 })),
    ...Array.from({ length: 4 }, () => ({ actionPhase: "flight", directBall: true, ballInFrame: true, jointFit: false, markerVisible: 0 })),
    ...Array.from({ length: 4 }, () => ({ actionPhase: "payoff", directBall: false, ballInFrame: false, payoffRegionInFrame: true, markerVisible: 0 })),
  ];
  assert.deepEqual(keyframePhaseProblems({ eventType: "goal" }, { keyframes: frames }), []);
  const playerOnlyOpening = frames.map((frame, index) => index < 5
    ? { ...frame, directBall: false, ballInFrame: false, jointFit: false }
    : frame);
  assert.ok(keyframePhaseProblems({ eventType: "goal" }, { keyframes: playerOnlyOpening }).includes("opening_player_ball_not_locked"));
  const lateMarker = frames.map((frame) => frame.actionPhase === "flight" ? { ...frame, markerVisible: 1 } : frame);
  assert.ok(keyframePhaseProblems({ eventType: "goal" }, { keyframes: lateMarker }).includes("player_marker_continues_after_contact"));
});

test("keyframe opening lock begins at the declared action origin after broadcast pre-roll", () => {
  const preRoll = Array.from({ length: 5 }, (_, index) => ({ time: index * 0.2, actionPhase: "setup", directBall: false, ballInFrame: false, jointFit: false, markerVisible: 0 }));
  const action = [
    ...Array.from({ length: 5 }, (_, index) => ({ time: 1.16 + index * 0.2, actionPhase: "setup", directBall: true, ballInFrame: true, jointFit: index > 0, markerVisible: 1 })),
    ...Array.from({ length: 3 }, (_, index) => ({ time: 2.2 + index * 0.2, actionPhase: "contact", directBall: true, ballInFrame: true, jointFit: true, markerVisible: 1 })),
    ...Array.from({ length: 4 }, (_, index) => ({ time: 2.8 + index * 0.2, actionPhase: "flight", directBall: true, ballInFrame: true, jointFit: false, markerVisible: 0 })),
    ...Array.from({ length: 4 }, (_, index) => ({ time: 3.6 + index * 0.2, actionPhase: "payoff", directBall: false, ballInFrame: false, payoffRegionInFrame: true, markerVisible: 0 })),
  ];
  const moment = { eventType: "goal", startTime: 470.84, trackingBrief: { originTime: 472.04 } };
  assert.deepEqual(keyframePhaseProblems(moment, { keyframes: [...preRoll, ...action] }), []);
});

test("verified sliding finish survives ball occlusion at contact only with a visible goalmouth payoff", () => {
  const keyframes = [
    ...Array.from({ length: 5 }, () => ({ actionPhase: "setup", directBall: true, ballInFrame: true, jointFit: true, markerVisible: 0 })),
    { actionPhase: "contact", directBall: false, ballInFrame: false, jointFit: false, markerVisible: 0 },
    { actionPhase: "flight", directBall: false, ballInFrame: false, jointFit: false, markerVisible: 0 },
    ...Array.from({ length: 5 }, () => ({ actionPhase: "payoff", directBall: false, ballInFrame: false, jointFit: false, payoffRegionInFrame: true, markerVisible: 0 })),
  ];
  const moment = { eventType: "goal", semanticVerified: true, actionComplete: true, confidence: .98, ballVisible: true, mainPlayerVisible: true };
  const phaseEvidence = {
    version: 1,
    setup: { samples: 99, jointCoverage: .9293, directJointCoverage: .8283, directBallCoverage: .899, ballCoverage: 1 },
    contact: { samples: 6, jointCoverage: .5, directJointCoverage: .3333, directBallCoverage: .3333, ballCoverage: .5 },
    flight: { samples: 1, jointCoverage: 0, directJointCoverage: 0, directBallCoverage: 0, ballCoverage: 0 },
    payoff: { samples: 25, jointCoverage: 0, directJointCoverage: 0, directBallCoverage: .08, ballCoverage: .08, payoffCoverage: .8 },
  };
  const evidence = { keyframes, phaseEvidence, goalActionComplete: false, goalPayoffCoverage: .88,
    ballDetectionCoverage: .7222, playerDetectionCoverage: 1, jointVisibilityCoverage: .8016,
    jointFitCoverage: .7302, maxDirectBallGap: 2.2, cameraMaxStep: .1379,
    cameraStepP95: .0269, cameraJerkP95: .0149 };
  assert.deepEqual(keyframePhaseProblems(moment, evidence), []);
  assert.deepEqual(assessPlannedSceneTracking(moment, evidence), { usable: true, mode: "phase_verified_goal" });
  assert.ok(keyframePhaseProblems({ ...moment, semanticVerified: false }, evidence).includes("contact_keyframes_incomplete"));
});

test("verified replay survives one broadcast cut with complete contact, flight and payoff", () => {
  const phaseEvidence={version:1,
    setup:{samples:26,jointCoverage:.5385,directJointCoverage:.4615,directBallCoverage:.7692,ballCoverage:.8462},
    contact:{samples:6,jointCoverage:.6667,directJointCoverage:.5,directBallCoverage:.8333,ballCoverage:1},
    flight:{samples:7,jointCoverage:1,directJointCoverage:1,directBallCoverage:1,ballCoverage:1},
    payoff:{samples:39,jointCoverage:.7949,directJointCoverage:.5897,directBallCoverage:.641,ballCoverage:.8718}};
  const moment={eventType:"goal",storyPhase:"replay",isReplay:true,ballVisible:true,mainPlayerVisible:true,confidence:.95,visualClarity:92};
  const evidence={phaseEvidence,goalActionComplete:true,goalPayoffCoverage:.7692,playerDetectionCoverage:1,
    jointFitCoverage:.726,maxDirectBallGap:.4,cameraMaxStep:.273,cameraStepP95:.0572,cameraJerkP95:.0678,
    keyframes:[...Array.from({length:16},(_,i)=>({cameraX:.8-i*.01,sceneCut:false})),
      ...Array.from({length:5},(_,i)=>({cameraX:.7+i*.05,sceneCut:false}))]};
  assert.deepEqual(assessPlannedSceneTracking(moment,evidence),{usable:true,mode:"phase_verified_goal"});
});
test("tracking preserves a planned replay when local and whole-video evidence agree", () => {
  const assessment = assessPlannedSceneTracking(
    { eventType: "goal", storyPhase: "replay", role: "proof", isReplay: true, ballVisible: true, mainPlayerVisible: true, confidence: 0.95, visualClarity: 92 },
    { openingJointVisible: false, playerDetectionCoverage: 1, ballDetectionCoverage: 0.83, jointVisibilityCoverage: 0.83, jointFitCoverage: 0.72, maxDirectBallGap: 0.33, goalPayoffCoverage: 0.5, cameraMaxStep: 0.03, cameraStepP95: 0.02, cameraJerkP95: 0.01 },
  );
  assert.deepEqual(assessment, { usable: true, mode: "ai_confirmed_joint_scene" });
});

test("tracking still rejects a planned gameplay scene with persistently missing joint framing", () => {
  const assessment = assessPlannedSceneTracking(
    { eventType: "normal_play", storyPhase: "action", role: "action", ballVisible: true, mainPlayerVisible: true, confidence: 0.95, visualClarity: 90 },
    { openingJointVisible: false, playerDetectionCoverage: 1, ballDetectionCoverage: 0.31, jointVisibilityCoverage: 0.31, jointFitCoverage: 0.22, maxDirectBallGap: 1.2, cameraMaxStep: 0.03, cameraStepP95: 0.02, cameraJerkP95: 0.01 },
  );
  assert.equal(assessment.usable, false);
});

test("phase coverage tolerates one missed setup sample without weakening payoff proof", () => {
  const phaseEvidence = {
    version: 1,
    setup: { samples: 33, jointCoverage: .75, directJointCoverage: .4848, directBallCoverage: .6061, ballCoverage: .75 },
    contact: { samples: 6, jointCoverage: .5, directJointCoverage: .5, directBallCoverage: .8333, ballCoverage: 1 },
    flight: { samples: 2, jointCoverage: 1, directJointCoverage: 1, directBallCoverage: 1, ballCoverage: 1 },
    payoff: { samples: 21, jointCoverage: .7143, directJointCoverage: .4286, directBallCoverage: .4286, ballCoverage: .7143, payoffCoverage: .4762 },
  };
  const evidence = { phaseEvidence, goalActionComplete: true, goalPayoffCoverage: .8095, ballDetectionCoverage: .5614, playerDetectionCoverage: 1, jointVisibilityCoverage: .7018, jointFitCoverage: .614, maxDirectBallGap: .6, cameraMaxStep: .0327, cameraStepP95: .0272, cameraJerkP95: .0113 };
  assert.deepEqual(assessPlannedSceneTracking({ eventType: "goal", actionComplete: true, ballVisible: true, mainPlayerVisible: true }, evidence), { usable: true, mode: "phase_verified_goal" });
});

test("semantic phase proof accepts a coherent broadcast pan but still requires contact and payoff", () => {
  const phaseEvidence = {
    version: 1,
    setup: { samples: 33, jointCoverage: .62, directJointCoverage: .5758, directBallCoverage: .7273, ballCoverage: .75 },
    contact: { samples: 6, jointCoverage: .8333, directJointCoverage: .8333, directBallCoverage: .8333, ballCoverage: .8333 },
    flight: { samples: 4, jointCoverage: .5, directJointCoverage: .5, directBallCoverage: .5, ballCoverage: .5 },
    payoff: { samples: 24, jointCoverage: .25, directJointCoverage: .2083, directBallCoverage: .25, ballCoverage: .3, payoffCoverage: .75 },
  };
  const evidence = { phaseEvidence, goalActionComplete: false, goalPayoffCoverage: .75, ballDetectionCoverage: .533, playerDetectionCoverage: 1, jointVisibilityCoverage: .55, jointFitCoverage: .467, maxDirectBallGap: .9, cameraMaxStep: .0517, cameraStepP95: .0455, cameraJerkP95: .0161, keyframes: [0, .02, .04, .06, .08, .10].map((cameraX) => ({ cameraX, sceneCut: false })) };
  const moment = { eventType: "goal", semanticVerified: true, actionComplete: true, ballVisible: true, mainPlayerVisible: true, confidence: .96 };
  assert.deepEqual(assessPlannedSceneTracking(moment, evidence), { usable: true, mode: "phase_verified_goal" });
  assert.equal(assessPlannedSceneTracking({ ...moment, semanticVerified: false }, evidence).usable, false);
});

test("one isolated broadcast cut does not look like sustained camera shake", () => {
  const phase = { samples: 8, jointCoverage: .9, directJointCoverage: .8, directBallCoverage: .8, ballCoverage: 1, payoffCoverage: 1 };
  const evidence = { phaseEvidence: { version: 1, setup: phase, contact: phase, flight: phase, payoff: phase }, goalActionComplete: true, goalPayoffCoverage: 1, ballDetectionCoverage: .8, playerDetectionCoverage: 1, jointVisibilityCoverage: .9, jointFitCoverage: .82, maxDirectBallGap: .4, cameraMaxStep: .65, cameraStepP95: .006, cameraJerkP95: .014, keyframes: [{ cameraX: .1 }, { cameraX: .75 }, { cameraX: .755 }, { cameraX: .76 }] };
  assert.deepEqual(assessPlannedSceneTracking({ eventType: "goal" }, evidence), { usable: true, mode: "phase_verified_goal" });
});
test("a player-only crop is rejected when direct ball visibility is not recoverable", () => {
  assert.deepEqual(assessPlannedSceneTracking(
    { eventType: "normal_play", trackingBrief: { cameraMode: "reaction" } },
    undefined,
  ), { usable: true, mode: "planned_reaction" });
  const assessment = assessPlannedSceneTracking(
    { eventType: "shot_on_target", storyPhase: "action", role: "evidence", ballVisible: false, mainPlayerVisible: true, confidence: 0.95, visualClarity: 90 },
    { openingJointVisible: false, playerDetectionCoverage: 1, ballDetectionCoverage: 0.12, jointVisibilityCoverage: 0.12, jointFitCoverage: 0.1, maxDirectBallGap: 3.2, goalPayoffCoverage: 1, cameraMaxStep: 0.03, cameraStepP95: 0.02, cameraJerkP95: 0.01 },
  );
  assert.deepEqual(assessment, { usable: false, mode: "ball_not_visibly_continuous" });
});

test("a slow-motion replay may bridge only short same-shot ball occlusions", () => {
  const phaseEvidence = { version: 1,
    setup: { samples: 72, directBallCoverage: .2917, ballCoverage: 1, jointCoverage: .6528, directJointCoverage: .25, payoffCoverage: 0 },
    contact: { samples: 13, directBallCoverage: .3077, ballCoverage: 1, jointCoverage: 1, directJointCoverage: .3077, payoffCoverage: 0 },
    flight: { samples: 24, directBallCoverage: .1667, ballCoverage: 1, jointCoverage: .9, directJointCoverage: .125, payoffCoverage: 0 },
    payoff: { samples: 42, directBallCoverage: .2857, ballCoverage: .619, jointCoverage: .3571, directJointCoverage: .1429, payoffCoverage: .5238 },
  };
  const keyframes = [
    ...[0,1,2,3,4].map((index) => ({ time:index*.04, actionPhase:"setup", directBall:index===0, ballGuidance:true, ballInFrame:true, jointFit:index!==1 && index!==2, cameraX:.50+index*.001 })),
    { time:.3, actionPhase:"contact", directBall:true, ballGuidance:true, ballInFrame:true, jointFit:true, cameraX:.505 },
    { time:.4, actionPhase:"flight", directBall:false, ballGuidance:true, ballInFrame:true, jointFit:true, cameraX:.506 },
    { time:.5, actionPhase:"payoff", directBall:false, ballGuidance:true, ballInFrame:true, jointFit:false, payoffRegionInFrame:false, cameraX:.507 },
  ];
  const evidence = { phaseEvidence, goalActionComplete: false, goalPayoffCoverage: .5238, actionBallFramingCoverage: 1, ballDetectionCoverage: .2657, playerDetectionCoverage: 1, jointVisibilityCoverage: .75, jointFitCoverage: .7111, maxDirectBallGap: 2.84, cameraMaxStep: .057, cameraStepP95: .019, cameraJerkP95: .0083, keyframes };
  const moment = { eventType: "goal", isReplay: true, storyPhase: "replay", semanticVerified: true, actionComplete: true, ballVisible: true, mainPlayerVisible: true, confidence: .98 };
  assert.deepEqual(assessPlannedSceneTracking(moment, evidence), { usable: true, mode: "phase_verified_goal" });
  assert.deepEqual(keyframePhaseProblems(moment, evidence), []);
  assert.ok(keyframePhaseProblems({ ...moment, isReplay:false, storyPhase:"action" }, evidence).includes("opening_player_ball_not_locked"));
  assert.equal(assessPlannedSceneTracking(moment, { ...evidence, actionBallFramingCoverage: .6 }).usable, false);
});

test("full-bleed repair is accepted only after final-crop geometry is recomputed", () => {
  const phaseEvidence = { version: 1,
    setup: { samples: 78, directBallCoverage: .2949, ballCoverage: .7692, jointCoverage: .7692, directJointCoverage: .2949, payoffCoverage: 0 },
    contact: { samples: 14, directBallCoverage: .2143, ballCoverage: 1, jointCoverage: 1, directJointCoverage: .2143, payoffCoverage: 0 },
    flight: { samples: 19, directBallCoverage: .3158, ballCoverage: .3158, jointCoverage: .3158, directJointCoverage: .3158, payoffCoverage: .6316 },
    payoff: { samples: 38, directBallCoverage: 0, ballCoverage: 0, jointCoverage: 0, directJointCoverage: 0, payoffCoverage: .5526 },
  };
  const moment = { eventType: "goal", isReplay: true, storyPhase: "replay", semanticVerified: true,
    actionComplete: true, ballVisible: true, mainPlayerVisible: true, confidence: .95 };
  const evidence = { layoutMode: "action", fullBleedRepair: true, phaseEvidence, ballDetectionCoverage: .2143,
    playerDetectionCoverage: 1, goalPayoffCoverage: .7895, keyframes: [] };
  assert.equal(assessPlannedSceneTracking(moment, evidence).usable, false);
  const recomputed = { ...evidence, finalCropMetricsVersion: 2, finalCropVerified: true,
    goalActionComplete: true, actionBallFramingCoverage: .95 };
  assert.deepEqual(assessPlannedSceneTracking(moment, recomputed),
    { usable: true, mode: "full_bleed_repaired" });
  assert.equal(assessPlannedSceneTracking(moment, { ...recomputed, finalCropVerified: false }).usable, false);
  assert.equal(assessPlannedSceneTracking({ ...moment, semanticVerified: false }, recomputed).usable, false);
});
test("a completed goal may hold briefly on the net and goalkeeper after the ball disappears", () => {
  const evidence = { openingJointVisible: true, playerDetectionCoverage: 1, ballDetectionCoverage: 0.52, jointVisibilityCoverage: 0.97, jointFitCoverage: 0.95, maxDirectBallGap: 3.24, goalPayoffCoverage: 0.92, goalActionComplete: true, actionBallFramingCoverage: 1, cameraMaxStep: 0.03, cameraStepP95: 0.02, cameraJerkP95: 0.01 };
  assert.deepEqual(assessPlannedSceneTracking(
    { eventType: "goal", storyPhase: "action", role: "evidence" },
    evidence,
  ), { usable: true, mode: "strict" });
  assert.equal(assessPlannedSceneTracking(
    { eventType: "normal_play", storyPhase: "action", role: "evidence" },
    evidence,
  ).usable, false);
});
test("a goal scene is rejected when its final frames do not show the payoff", () => {
  const assessment = assessPlannedSceneTracking(
    { eventType: "goal", storyPhase: "action", role: "hook" },
    { openingJointVisible: true, ballDetectionCoverage: 0.9, jointVisibilityCoverage: 0.9, jointFitCoverage: 0.85, maxDirectBallGap: 0.3, goalPayoffCoverage: 0.05, cameraMaxStep: 0.03, cameraStepP95: 0.02, cameraJerkP95: 0.01 },
  );
  assert.deepEqual(assessment, { usable: false, mode: "missing_goal_payoff" });
});

test("a celebration-like goal clip is rejected when contact and ball flight are incomplete", () => {
  const assessment = assessPlannedSceneTracking(
    { eventType: "goal", storyPhase: "action", role: "hook" },
    { openingJointVisible: true, ballDetectionCoverage: 0.9, jointVisibilityCoverage: 0.9, jointFitCoverage: 0.85, maxDirectBallGap: 0.3, goalPayoffCoverage: 0.8, goalActionComplete: false, cameraMaxStep: 0.03, cameraStepP95: 0.02, cameraJerkP95: 0.01 },
  );
  assert.deepEqual(assessment, { usable: false, mode: "incomplete_goal_action" });
});

test("a visually complete goal recovers a missed detector phase only with strong local evidence", () => {
  const assessment = assessPlannedSceneTracking(
    { eventType: "goal", storyPhase: "action", actionComplete: true, ballVisible: true, mainPlayerVisible: true, confidence: 0.98 },
    { openingJointVisible: true, playerDetectionCoverage: 1, ballDetectionCoverage: 0.77, jointVisibilityCoverage: 1, jointFitCoverage: 0.75, maxDirectBallGap: 0.6, goalPayoffCoverage: 1, goalActionComplete: false, cameraMaxStep: 0.118, cameraStepP95: 0.018, cameraJerkP95: 0.0198 },
  );
  assert.deepEqual(assessment, { usable: true, mode: "strict" });
});

test("an otherwise trackable scene is rejected when the crop visibly shakes", () => {
  const assessment = assessPlannedSceneTracking(
    { eventType: "normal_play", storyPhase: "action", role: "action", ballVisible: true, mainPlayerVisible: true },
    { openingJointVisible: true, playerDetectionCoverage: 1, ballDetectionCoverage: 0.9, jointVisibilityCoverage: 0.95, jointFitCoverage: 0.95, maxDirectBallGap: 0.2, goalPayoffCoverage: 1, cameraMaxStep: 0.2, cameraStepP95: 0.08, cameraJerkP95: 0.09 },
  );
  assert.deepEqual(assessment, { usable: false, mode: "unstable_camera" });
});

test("an isolated broadcast cut does not reject an otherwise stable joint crop", () => {
  const assessment = assessPlannedSceneTracking(
    { eventType: "save", storyPhase: "replay", role: "proof", ballVisible: true, mainPlayerVisible: true },
    { openingJointVisible: true, playerDetectionCoverage: 1, ballDetectionCoverage: 0.86, jointVisibilityCoverage: 1, jointFitCoverage: 0.81, maxDirectBallGap: 0.3, cameraMaxStep: 0.22, cameraStepP95: 0.018, cameraJerkP95: 0.12 },
  );
  assert.deepEqual(assessment, { usable: true, mode: "strict" });
});

test("strong sustained joint evidence can recover one missed opening sample", () => {
  const assessment = assessPlannedSceneTracking(
    { eventType: "big_chance", storyPhase: "action", role: "evidence", ballVisible: true, mainPlayerVisible: true },
    { openingJointVisible: false, playerDetectionCoverage: 1, ballDetectionCoverage: 0.75, jointVisibilityCoverage: 0.9, jointFitCoverage: 0.875, maxDirectBallGap: 0.8, cameraMaxStep: 0.018, cameraStepP95: 0.018, cameraJerkP95: 0.003 },
  );
  assert.deepEqual(assessment, { usable: true, mode: "strict" });
});
test("narration timing validation binds every spoken beat to its visual", () => {
  assert.deepEqual(synchronizationProblems([
    { beatId: "beat-1", momentId: "goal", narration: "The runner opens the lane.", visualStart: 0, visualDuration: 3.2, speechDuration: 3 },
    { beatId: "support", momentId: "replay", narration: "", visualStart: 3.2, visualDuration: 2.4, speechDuration: 0 },
  ]), []);
  assert.deepEqual(synchronizationProblems([
    { beatId: "beat-1", momentId: "wrong", narration: "The ball reaches the striker.", visualStart: 0, visualDuration: 1.2, speechDuration: 2.1 },
  ]), ["speech_exceeds_visual:wrong"]);
  assert.deepEqual(synchronizationProblems([
    { beatId: "beat-2", momentId: "silent", narration: "The goalkeeper commits early.", visualStart: 0, visualDuration: 3, speechDuration: 0 },
  ]), ["missing_speech:silent"]);
});
test("logo masking uses detected regions and a deterministic corner fallback", () => {
  const detected = [{ x: 0.2, y: 0.1, width: 0.08, height: 0.06, confidence: 0.9 }];
  assert.deepEqual(effectiveOverlayMasks(detected), detected);
  const fallback = effectiveOverlayMasks([]);
  assert.equal(fallback.length, 1);
  assert.equal(fallback[0].id, "fallback-top-right-watermark");
  assert.deepEqual(sourceMaskFilters(fallback, { width: 1280, height: 720 }), ["delogo=x=1120:y=9:w=147:h=104:show=0"]);
});
test("content is written for the requested duration only after footage is verified", () => {
  const prompt = buildContentWritingPrompt({ sourceDuration: 529.1, targetDuration: 60, verifiedEvidenceDuration: 37.5, editableEvidenceDuration: 66.2, evidenceSlotCount: 10, verifiedGoalActionCount: 1 });
  assert.match(prompt, /complete source from beginning to end/i);
  assert.match(prompt, /only locally tracked, frameable evidence/i);
  assert.match(prompt, /requested approximately 60 seconds/i);
  assert.match(prompt, /37\.5 seconds of unique verified source evidence/i);
  assert.match(prompt, /support up to 66\.2 seconds/i);
  assert.match(prompt, /do not choose timestamps or edit clips yet/i);
  assert.match(prompt, /approximately 60 seconds/i);
  assert.match(prompt, /123-138 words/i);
  assert.match(prompt, /exactly 10 distinct verified scene slots/i);
  assert.match(prompt, /exactly 8 content beats/i);
  assert.match(prompt, /write only as a match recap/i);
  assert.match(prompt, /confirmed goal first/i);
  assert.match(prompt, /1 locally verified live goal action/i);
  assert.match(prompt, /immediate consequence/i);
});
test("multi-goal content opens with a shared thesis instead of one incident question", () => {
  const prompt = buildContentWritingPrompt({ durationMode: "auto", sourceDuration: 529, targetDuration: 32,
    verifiedEvidenceDuration: 30, editableEvidenceDuration: 33, evidenceSlotCount: 6, verifiedGoalActionCount: 3 });
  assert.match(prompt, /multi-goal highlight analysis/i);
  assert.match(prompt, /not ask a question that applies only to the first goal/i);
});

test("content cannot claim a goal when only reactions and non-goal actions were verified", () => {
  const beats = Array.from({ length: 8 }, (_, index) => ({
    beatId: `beat-${index + 1}`,
    role: index === 0 ? "hook" : index === 7 ? "conclusion" : "analysis",
    narration: index === 0
      ? "The equalizer changes the match after sustained pressure creates a decisive goal."
      : "Pressure, timing, movement, and technique explain the visible chance before the defence recovers.",
  }));
  const plan = normalizeContentPlan({
    editorialThesis: "Pressure changes the match.",
    storyQuestion: "Why did momentum change?",
    storyAnswer: "Repeated pressure created better chances.",
    contentBeats: beats,
  }, 60);
  assert.ok(contentPlanProblems(plan, 60, 8, 0).includes("goal_claim_without_verified_live_action"));
  assert.ok(!contentPlanProblems(plan, 60, 8, 1).includes("goal_claim_without_verified_live_action"));
  assert.match(buildContentWritingPrompt({ sourceDuration: 500, targetDuration: 60, evidenceSlotCount: 8, verifiedGoalActionCount: 0 }), /no locally verified live goal action/i);
});

test("evidence alignment uses only pre-verified footage for the requested minute", () => {
  const prompt = buildEvidenceAlignmentPrompt({ targetDuration: 60, intensity: "dynamic", verifiedEvidenceDuration: 37.5, editableEvidenceDuration: 66.2 });
  assert.match(prompt, /content is already approved/i);
  assert.match(prompt, /already passed local ball, involved-player, joint-framing, and camera-stability verification/i);
  assert.match(prompt, /37\.5 unique source seconds/i);
  assert.match(prompt, /editable capacity of 66\.2 seconds/i);
  assert.match(prompt, /do not rewrite the analysis/i);
  assert.match(prompt, /finishing pass will invent or duplicate a replay/i);
  assert.match(prompt, /no fixed per-scene duration/i);
  assert.match(prompt, /never trim a candidate to fill a timeline gap/i);
  assert.match(prompt, /goal cluster contiguous/i);
  assert.match(prompt, /thick red ring may identify only the locally verified scorer/i);
});

test("goal-first validation requires same-story replay and celebration", () => {
  const candidates = [
    { id: "goal", eventType: "goal", storyId: "goal-a", storyPhase: "action", keepDecision: "keep" },
    { id: "replay", eventType: "goal", storyId: "goal-a", storyPhase: "replay", isReplay: true, keepDecision: "replay" },
    { id: "reaction", eventType: "celebration", storyId: "goal-a", storyPhase: "reaction", keepDecision: "support" },
  ];
  assert.deepEqual(highlightStoryDeficiencies(candidates), []);
  assert.deepEqual(highlightSequenceProblems(candidates.map((moment, editOrder) => ({ ...moment, editOrder }))), []);
  assert.ok(highlightStoryDeficiencies(candidates.slice(0, 1)).some((problem) => problem.startsWith("missing_same_goal_replay")));
  assert.ok(highlightStoryDeficiencies(candidates.slice(0, 2)).some((problem) => problem.startsWith("missing_immediate_goal_celebration")));
  const unrelated = { id: "other", eventType: "shot_on_target", storyId: "other", storyPhase: "action", keepDecision: "keep" };
  const broken = [candidates[0], unrelated, candidates[1], candidates[2]].map((moment, editOrder) => ({ ...moment, editOrder }));
  assert.ok(highlightSequenceProblems(broken).includes("goal_cut_to_unrelated_scene:goal"));
  const loneGoal = { ...candidates[0], editOrder: 0 };
  assert.deepEqual(highlightSequenceProblems([loneGoal], {
    availableMoments: [loneGoal],
    requireAvailableCompanionsOnly: true,
  }), []);
  assert.ok(highlightSequenceProblems([loneGoal, { ...unrelated, editOrder: 1 }], {
    availableMoments: candidates,
    requireAvailableCompanionsOnly: true,
  }).includes("goal_cut_to_unrelated_scene:goal"));
});

test("each goal sends only its two clearest complete angles to local tracking", () => {
  const moments = [
    { id: "live", eventType: "goal", storyId: "goal-a", storyPhase: "action", keepDecision: "keep", semanticVerified: true, actionComplete: true, confidence: .92, importanceScore: 90 },
    { id: "replay-best", eventType: "goal", storyId: "goal-a", storyPhase: "replay", isReplay: true, keepDecision: "replay", semanticVerified: true, actionComplete: true, confidence: .95, visualClarity: 95 },
    { id: "replay-third", eventType: "goal", storyId: "goal-a", storyPhase: "replay", isReplay: true, keepDecision: "replay", semanticVerified: true, actionComplete: true, confidence: .80, visualClarity: 70 },
    { id: "reaction", eventType: "celebration", storyId: "goal-a", storyPhase: "reaction", keepDecision: "support" },
  ];
  const limited = limitIncidentActionViews(moments);
  assert.equal(limited.find((moment) => moment.id === "replay-best").keepDecision, "replay");
  assert.equal(limited.filter((moment) => moment.eventType === "goal" && moment.keepDecision !== "reject").length, 2);
  assert.equal(limited.find((moment) => moment.id === "live").keepDecision, "reject");
  assert.equal(limited.find((moment) => moment.id === "reaction").keepDecision, "support");
  const duplicated = moments.map((moment, editOrder) => ({ ...moment, editOrder }));
  assert.ok(highlightSequenceProblems(duplicated).includes("goal_has_multiple_replays:goal-a"));
});

test("local player-and-ball evidence chooses one stable angle for every distinct goal", () => {
  const moments = [
    { id: "g1-live", storyId: "g1", eventType: "goal", selectionLocked: true, semanticVerified: true, actionComplete: true, keepDecision: "keep" },
    { id: "g1-replay", storyId: "g1", eventType: "goal", storyPhase: "replay", isReplay: true, selectionLocked: true, semanticVerified: true, actionComplete: true, keepDecision: "replay", trackingDecision: "phase_verified_goal" },
    { id: "g1-reaction", storyId: "g1", eventType: "celebration", storyPhase: "reaction", selectionLocked: true, keepDecision: "support" },
    { id: "g2-live", storyId: "g2", eventType: "goal", selectionLocked: true, semanticVerified: true, actionComplete: true, keepDecision: "keep" },
    { id: "g2-replay", storyId: "g2", eventType: "goal", storyPhase: "replay", isReplay: true, selectionLocked: true, semanticVerified: true, actionComplete: true, keepDecision: "replay" },
  ];
  const selected = chooseTrackedIncidentAngles(moments, new Map([
    ["g1-live", 830], ["g1-replay", 1120], ["g2-live", 1090], ["g2-replay", 700],
  ]), new Map([
    ["g1-live", true], ["g1-replay", true], ["g2-live", true], ["g2-replay", false],
  ]));
  assert.deepEqual(selected.filter((moment) => moment.chosenIncidentAngle).map((moment) => moment.id), ["g1-replay", "g2-live"]);
  assert.equal(selected.find((moment) => moment.id === "g1-live").selectionLocked, false);
  assert.equal(selected.find((moment) => moment.id === "g2-replay").keepDecision, "reject");
  assert.equal(selected.find((moment) => moment.id === "g1-reaction").selectionLocked, true);
});

test("incident angle comparison never promotes the highest-scoring failed track", () => {
  const moments = [
    { id: "live", storyId: "goal", eventType: "goal", selectionLocked: true, keepDecision: "keep" },
    { id: "replay", storyId: "goal", eventType: "goal", selectionLocked: true, keepDecision: "replay" },
  ];
  const selected = chooseTrackedIncidentAngles(moments,
    new Map([["live", 999], ["replay", 500]]),
    new Map([["live", false], ["replay", false]]));
  assert.equal(selected.some((moment) => moment.chosenIncidentAngle === true), false);
  assert.ok(selected.every((moment) => moment.selectionDecision === "incident_has_no_verified_angle"));
  assert.ok(selected.every((moment) => moment.keepDecision === "reject"));
});

test("processor repairs replay-only goal stories before locking portrait scenes", () => {
  const server = readFileSync(new URL("../local-processor/server.mjs", import.meta.url), "utf8");
  const recovery = server.indexOf("const replayOnlyGoalStories");
  const lock = server.indexOf("lockInitialSceneSelection", recovery);
  assert.ok(recovery >= 0 && lock > recovery);
  assert.match(server.slice(recovery, lock), /complete LIVE scoring action: buildup, decisive contact, ball flight, goalmouth result, then reaction/);
});

test("an AI-confirmed replay still fails when its virtual camera is unstable", () => {
  const assessment = assessPlannedSceneTracking(
    { eventType: "save", storyPhase: "replay", role: "proof", isReplay: true, ballVisible: true, mainPlayerVisible: true, confidence: 0.95, visualClarity: 94 },
    { openingJointVisible: false, playerDetectionCoverage: 1, ballDetectionCoverage: 0.82, jointVisibilityCoverage: 0.8, jointFitCoverage: 0.7, maxDirectBallGap: 0.4, cameraMaxStep: 0.14, cameraStepP95: 0.05, cameraJerkP95: 0.04 },
  );
  assert.deepEqual(assessment, { usable: false, mode: "unstable_camera" });
});
test("content validation rejects short scripts and directing filler", () => {
  const beats = Array.from({ length: 12 }, (_, index) => ({
    beatId: "beat-" + index,
    narration: index === 0 ? "Look at the replay because this sentence is deliberately invalid filler language." : "Movement and timing create the decisive advantage before the final action becomes obvious.",
    evidenceNeed: "Player and ball together",
    captionText: "KEY DETAIL",
  }));
  const plan = normalizeContentPlan({
    editorialThesis: "A complete thesis",
    storyQuestion: "Why does the move work?",
    storyAnswer: "Movement creates the space.",
    contentBeats: beats,
  }, 60);
  assert.ok(contentPlanProblems(plan, 60).includes("directing_filler_language"));
  assert.ok(contentPlanProblems(plan, 60).includes("recap_mentions_editing_or_replay"));
  const short = normalizeContentPlan({
    editorialThesis: "A thesis",
    storyQuestion: "Why?",
    storyAnswer: "Timing.",
    contentBeats: beats.slice(0, 2),
  }, 60);
  assert.ok(contentPlanProblems(short, 60).some((problem) => problem.startsWith("script_too_short")));
});

test("content validation rejects production language even without directing filler", () => {
  const beats = Array.from({ length: 12 }, (_, index) => ({
    beatId: "beat-" + index,
    narration: index === 0
      ? "The replay angle confirms the decisive movement before the finish."
      : "Pressure and movement create the decisive advantage before the final action becomes obvious.",
    evidenceNeed: "Player and ball together",
    captionText: "KEY DETAIL",
  }));
  const plan = normalizeContentPlan({
    editorialThesis: "A complete thesis",
    storyQuestion: "Why does the move work?",
    storyAnswer: "Movement creates the space.",
    contentBeats: beats,
  }, 60);
  assert.ok(contentPlanProblems(plan, 60).includes("recap_mentions_editing_or_replay"));
});

test("content validation respects the number of distinct verified scene slots", () => {
  const contentBeats = Array.from({ length: 6 }, (_, index) => ({
    beatId: `beat-${index + 1}`,
    role: index === 0 ? "hook" : index === 5 ? "conclusion" : "analysis",
    narration: "Connected analysis explains pressure, movement, timing, execution, and the visible consequence clearly.",
  }));
  const plan = normalizeContentPlan({
    editorialThesis: "One connected football thesis.",
    storyQuestion: "Why did the chance appear?",
    storyAnswer: "Movement opened space before the final action.",
    contentBeats,
  }, 65);
  assert.ok(!contentPlanProblems(plan, 65, 6).includes("too_few_content_beats"));
  assert.ok(contentPlanProblems(plan, 65).includes("too_few_content_beats"));
});

test("content beats are fitted to unique verified evidence slots before alignment", () => {
  const beats = Array.from({ length: 9 }, (_, index) => ({
    beatId: `beat-${index + 1}`,
    role: index === 0 ? "hook" : index === 8 ? "conclusion" : index === 3 ? "evidence" : "analysis",
    narration: `Connected football analysis sentence ${index + 1} explains the visible decision and its consequence.`,
    evidenceNeed: `Verified visible action ${index + 1}`,
    captionText: `DETAIL ${index + 1}`,
  }));
  const plan = normalizeContentPlan({
    editorialThesis: "One connected football thesis.",
    storyQuestion: "Why did the move work?",
    storyAnswer: "Movement and timing created the finish.",
    contentBeats: beats,
  }, 60);
  const fitted = fitContentPlanToEvidenceSlots(plan, 8, 60);
  assert.equal(fitted.contentBeats.length, 8);
  assert.equal(fitted.contentBeats[0].role, "hook");
  assert.equal(fitted.contentBeats.at(-1).role, "conclusion");
  assert.ok(fitted.wordCount < plan.wordCount);
  assert.ok(fitted.contentBeats.every((beat) => /^Verified visible action \d+$/.test(beat.evidenceNeed)));
  assert.ok(fitted.contentBeats.every((beat) => !beat.evidenceNeed.includes(";")));
  assert.equal(fitContentPlanToEvidenceSlots(plan, 9, 60).contentBeats.length, 8);
});

test("planned visual duration accounts for playback and transitions", () => {
  const segments = Array.from({ length: 8 }, (_, index) => ({ startTime: index * 8, endTime: index * 8 + 7.5, playbackRate: 1, transitionDuration: 0.04 }));
  assert.ok(plannedSegmentDuration(segments) > 59.5);
  assert.ok(plannedSegmentDuration(segments) < 60.1);
});

test("overlong complete-scene alignment is speed-fitted without dropping a content beat", () => {
  const segments = Array.from({ length: 8 }, (_, index) => ({
    candidateId: `candidate-${index + 1}`,
    beatId: `beat-${index + 1}`,
    startTime: index * 10,
    endTime: index * 10 + 8.4,
    playbackRate: 1,
    transitionDuration: 0.04,
  }));
  const fitted = fitSegmentPlaybackToDuration(segments, 60);
  assert.equal(fitted.length, 8);
  assert.ok(plannedSegmentDuration(fitted) <= 62.01);
  assert.ok(plannedSegmentDuration(fitted) >= 59);
  assert.ok(fitted.every((segment) => segment.playbackRate > 1 && segment.playbackRate <= 1.18));
});

test("an analytical freeze extends the planned scene by its verified hold", () => {
  const duration = plannedSegmentDuration([{
    startTime: 10,
    endTime: 16,
    playbackRate: 1,
    effect: "freeze_analysis",
    freezeDuration: 0.7,
  }]);
  assert.equal(duration, 6.7);
});

test("verified decisive actions can support the target through restrained editorial expansion", () => {
  const moments = [
    { id: "goal", startTime: 0, endTime: 9.5, eventType: "goal", storyPhase: "action", storyId: "goal-a", keepDecision: "keep", trackingDecision: "strict", selectedForFinalVideo: true, editOrder: 0, importanceScore: 100, playerHighlight: true },
    { id: "foul", startTime: 20, endTime: 28, eventType: "foul", storyPhase: "action", storyId: "foul-a", keepDecision: "keep", trackingDecision: "strict", selectedForFinalVideo: true, editOrder: 1, importanceScore: 60 },
    { id: "chance", startTime: 40, endTime: 48, eventType: "big_chance", storyPhase: "action", storyId: "chance-a", keepDecision: "keep", trackingDecision: "strict", selectedForFinalVideo: true, editOrder: 2, importanceScore: 90, playerHighlight: true },
    { id: "reaction-1", startTime: 50, endTime: 59, eventType: "celebration", storyPhase: "reaction", storyId: "goal-a", keepDecision: "support", trackingDecision: "planned_reaction", selectedForFinalVideo: true, editOrder: 3 },
    { id: "reaction-2", startTime: 60, endTime: 65.5, eventType: "celebration", storyPhase: "reaction", storyId: "chance-a", keepDecision: "support", trackingDecision: "planned_reaction", selectedForFinalVideo: true, editOrder: 4 },
  ];
  assert.ok(editableEvidenceDuration(moments) >= 51);
  const expanded = expandVerifiedTimeline(moments, 52);
  const selected = expanded.filter((moment) => moment.selectedForFinalVideo);
  assert.ok(plannedSegmentDuration(selected) >= 51.25);
  assert.ok(plannedSegmentDuration(selected) <= 55);
  const generatedReplays = selected.filter((moment) => moment.trackingDecision === "verified_editorial_replay");
  assert.equal(generatedReplays.length, 0);
  assert.equal(selected.some((moment) => /--analysis-replay$/.test(moment.id)), false);
});
test("processor learns the target, verifies footage, writes content, then aligns the edit", () => {
  const source = readFileSync(new URL("../local-processor/server.mjs", import.meta.url), "utf8");
  const analyze = source.indexOf('updateJob(job, "analyzing", 12');
  const track = source.indexOf('updateJob(job, "tracking", 34');
  const verify = source.indexOf("await prepareIncidentEvidence", track);
  const durationGate = source.indexOf("editableDuration < requiredPlannedDuration", verify);
  const write = source.indexOf('updateJob(job, "writing_content", 40');
  const align = source.indexOf('updateJob(job, "aligning_content", 48', write);
  assert.ok(analyze >= 0 && analyze < track);
  assert.ok(track < verify && verify < durationGate);
  assert.ok(durationGate < write && write < align);
  assert.match(source, /Math\.ceil\(targetDuration \* 1\.5 \/ Math\.max\(1, chunkCount\)\)/);
  assert.match(source, /editableEvidenceDuration\(candidates\)/);
  assert.match(source, /expandVerifiedTimeline\(selected, job\.settings\.targetDuration\)/);
  assert.match(source, /chooseInitialScenesForLock\(candidates, job\.settings\)/);
  assert.match(source, /discoverAdditionalCandidatesWithGemini/);
  assert.match(source, /savedCoveredBeatCount < savedBeatCount/);
  assert.match(source, /savedDuration > planningCeiling\(job\.settings\) \+ 3/);
  assert.match(source, /fitContentPlanToEvidenceSlots\(contentPlan, verifiedDirectorSlots/);
  assert.match(source, /fitSegmentPlaybackToDuration\(alignment\.segments, settings\.targetDuration\)/);
  assert.match(source, /selectedBeatCount < contentPlan\.contentBeats\.length/);
  assert.match(source, /Split an overlong 13-plus-second interval/);
  assert.match(source, /trackLockedSceneUntilVerified/);
  assert.match(source, /resumeFromCandidates/);
  assert.match(source, /Scene \$\{sceneIndex \+ 1\}\/\$\{sceneCount\}/);
  assert.match(source, /ANALYSIS_CHUNK_SECONDS || 180/);
  assert.match(source, /mapWithConcurrency\(\s*lockedScenes,\s*trackingSceneConcurrency/);
  assert.doesNotMatch(source, /eligible.length > 3/);
  assert.match(source, /blockingAiQualityReview/);
  assert.match(source, /http:\/\/localhost:3001/);
  assert.match(source, /Deterministic chronological alignment of the approved Gemini recap script/);
  assert.match(source, /prepareIncidentEvidence\(job\.sourceKey, candidates/);
  assert.match(source, /httpOptions: \{ timeout: geminiRequestTimeoutMs \}/);
  assert.match(source, /missing_narration_beats_/);
  assert.doesNotMatch(source, /first verified evidence alignment produced/);
});
test("source semantics validate before scene lock, portrait repair follows lock, and voice is final", () => {
  const server = readFileSync(new URL("../local-processor/server.mjs", import.meta.url), "utf8");
  const semantic = server.indexOf("const initialSemanticResult = await verifyCandidateSemanticsWithGemini");
  const lock = server.indexOf("lockInitialSceneSelection");
  const tracking = server.indexOf("await prepareIncidentEvidence", lock);
  const alignment = server.indexOf('updateJob(job, "aligning_content", 48', tracking);
  const voice = server.indexOf('updateJob(job, "generating_commentary", 64', alignment);
  assert.ok(semantic >= 0 && semantic < lock && lock < tracking && tracking < alignment && alignment < voice);
  assert.match(server, /lockInitialSceneSelection\(candidates, \{ requireSemanticVerification: Boolean\(process\.env\.GEMINI_API_KEY\) \}\)/);
  assert.match(server, /!requireSemanticVerification \|\| moment\.semanticVerified === true/);
  assert.match(server, /selectionLocked: true/);
  assert.match(server, /const occupiedBySelectedScene = source\.some/);
  assert.match(server, /selectionLocked: false/);
  assert.match(server, /trackingPassed: completed\.assessment\.usable === true/);
  assert.doesNotMatch(server, /\{ usable: true, mode: "ball_first_continuity_repair" \}/);
  assert.match(server, /Rewriting narration without changing any scene/);
  assert.match(server, /candidates = candidates\.filter\(moment => moment\.selectionLocked === true\)/);
  assert.match(server, /replayOnlyGoalStories/);
  assert.match(server, /Do not relabel the replay as live/);
  assert.match(server, /rejectedGoalScenes\.length > 0 \|\| replayOnlyGoalStories\.length > 0 \|\| reactionOnlyGoalStories\.length > 0\s+\|\| suspiciousLateReplays\.length > 0 \|\| verifiedCapacity < requiredCapacity/);
  assert.doesNotMatch(server, /if \(rejectedPriorityScenes\.length > 0 \|\|/);
  assert.match(server, /const ranked = limitIncidentActionViews\(candidates\)\s+\.filter\(\(moment\) => complete\s+\? moment\.selectionLocked === true/);
  assert.doesNotMatch(server, /so they were removed instead of letterboxed/);
});test("approved content identity survives alignment and hard cuts stay streamable", () => {
  const server = readFileSync(new URL("../local-processor/server.mjs", import.meta.url), "utf8");
  const renderer = readFileSync(new URL("../local-processor/render-video-v2.mjs", import.meta.url), "utf8");
  const tracker = readFileSync(new URL("../local-processor/track-football-v2.py", import.meta.url), "utf8");
  assert.match(server, /beatId: reaction \? undefined : String\(directive\.beatId/);
  assert.match(server, /commentary: reaction \? undefined/);
  assert.match(server, /const startTime = candidate\.startTime/);
  assert.match(server, /const endTime = reaction \? Math\.min\(candidate\.endTime, startTime \+ 3\) : candidate\.endTime/);
  assert.doesNotMatch(server, /clamp\(Number\(directive\.startTime\)/);
  assert.match(server, /actionDuration <= maximumCompleteDuration/);
  assert.match(server, /const maximumCompleteDuration = MAX_SCENE_SECONDS/);
  assert.doesNotMatch(server, /complete 5-to-12-second|complete 4-to-15-second/);
  assert.doesNotMatch(server, /process\.env\.GEMINI_API_KEY && !isCompleteHighlights\(job\.settings\).*completedDiscoveryPasses/);
  assert.match(server, /const strategies = \[/);
  assert.match(server, /const decisiveIncident = \["goal", "disallowed_goal"\]/);
  assert.match(server, /if \(decisiveIncident\) strategies\.push/);
  assert.match(server, /sampleFps: 15, coarseSampleFps: Math\.min\(5, trackingCoarseSampleFps\), ballImageSize: 1600/);
  assert.doesNotMatch(server, /sampleFps: 20/);
  assert.match(tracker, /resolved_goal_hold = bool\(\s*goal_mode\s*and outcome_box is None/);
  assert.match(server, /fullBleedRepairEvidence/);
  assert.doesNotMatch(server, /mode: "ball_first_continuity_repair"/);
  assert.match(server, /finalCropMetricsVersion: 2/);
  assert.match(server, /cameraOwner = pairFits \? "carrier"/);
  assert.match(server, /if \(!player \|\| !hasBall \|\| playerBallDistance > \.18\) player = null/);
  assert.match(server, /const isolatedWeakBall = rawDirectBall/);
  assert.match(server, /Number\(dominantPlayer\?\.area \|\| 0\) >= \.12/);
  assert.match(server, /trimUnframeableDistributionLeadIns/);
  assert.match(server, /restorePossessionChainStarts/);
  assert.doesNotMatch(server, /if \(scene\.selectionLocked === true\) return scene/);
  assert.match(server, /semanticSignature: semanticSignature\(approved\)/);
  assert.match(server, /lead_in_trim_preserving_verified_possession_chain/);
  assert.match(server, /semanticOrigin - Number\(scene\.startTime\)/);
  assert.doesNotMatch(server, /locked_scene_repair_required/);
  assert.match(server, /seconds \+ duration > 105/);
  assert.match(server, /compact batch \$\{batchIndex \+ 1\}\/\$\{batches\.length\}/);
  assert.match(server, /TRACKING_SAMPLE_FPS \|\| 10/);
  assert.doesNotMatch(server, /directive\.commentary \|\| candidate\.commentary/);
  assert.match(server, /restoreContentBeatOrder/);
  assert.match(server, /restoreOriginalPlannedScenes/);
  assert.match(server, /semanticScore >= 30/);
  assert.match(server, /obviousIdentityProblems\(content\.contentScript, verifiedIdentityNames\(matchContext\)\)/);
  assert.doesNotMatch(server, /obviousIdentityProblems\(`\$\{content\.title\}/);
  assert.match(renderer, /edit boundaries are frame-exact cuts/);
  assert.doesNotMatch(renderer, /\]xfade=transition=/);
  assert.match(renderer, /ttsFiles\.durations/);
  assert.match(renderer, /synchronizationProblems/);
  assert.match(renderer, /tpad=stop_mode=clone/);
  assert.match(renderer, /fontsize='\$\{cue\.fontSize\}\*\(0\.92\+0\.08\*/);
  assert.match(renderer, /sparseCaptionCues\(moment/);
  assert.match(renderer, /captionAss\(cues, y, outputWidth, outputHeight\)/);
  assert.match(renderer, /concat=n=2:v=1:a=1/);
});
test("semantic backups prefer the same incident over a higher-importance unrelated clip", () => {
  const planned = {
    id: "clearance-action",
    selectedForFinalVideo: true,
    storyId: "goal-line-clearance",
    eventType: "save",
    description: "Cresswell clears Hakimi's header off the goal line.",
    commentary: "A heroic goal-line clearance protects the lead.",
  };
  const sameIncident = {
    id: "clearance-replay",
    storyId: "goal-line-clearance",
    eventType: "save",
    description: "Replay from the net shows the defender clearing the ball off the line.",
    importanceScore: 55,
  };
  const unrelatedGoal = {
    id: "unrelated-goal",
    storyId: "different-goal",
    eventType: "goal",
    description: "A striker scores and celebrates with teammates.",
    importanceScore: 99,
  };
  const unrelatedReaction = {
    id: "same-story-celebration", storyId: planned.storyId, eventType: "celebration", storyPhase: "reaction",
    description: "A player celebrates with teammates near the corner flag.",
  };
  assert.ok(semanticBackupScore(planned, unrelatedReaction) < 18);
  assert.ok(semanticBackupScore(planned, sameIncident) > semanticBackupScore(planned, unrelatedGoal));
  assert.equal(rankSemanticBackups([planned], [unrelatedGoal, sameIncident])[0].moment.id, "clearance-replay");
});

test("complete recaps preserve observed decisions and show disallowed-goal context", () => {
  const server = readFileSync(new URL("../local-processor/server.mjs", import.meta.url), "utf8");
  assert.match(server, /observedIncidentCandidates = candidates\.map/);
  assert.match(server, /incidentCoverage\(incidentRequirementCandidates\(candidates\)/);
  assert.match(server, /assertIncidentCoverage\(incidentRequirementCandidates\(candidates\), frameable\)/);
  assert.match(server, /!\["goal", "disallowed_goal"\]\.includes\(moment\.eventType\)/);
  assert.match(server, /incidentContext: 4/);
});

test("verified replays get only a narrow origin-cut tolerance", () => {
  const source=readFileSync(new URL("../local-processor/track-football-v2.py",import.meta.url),"utf8");
  assert.match(source,/minimum_origin_coverage = 0\.45 if moment\.get\("isReplay"\) else 0\.50/);
  assert.match(source,/goal_origin_coverage >= minimum_origin_coverage/);
  assert.match(source,/phase_evidence\["contact"\]\["directJointCoverage"\] >= 0\.35/);
  assert.match(source,/goal_flight_coverage >= 0\.35/);
});test("tracker requires direct ball evidence and one stable highlight identity", () => {
  const tracker = readFileSync(new URL("../local-processor/track-football-v2.py", import.meta.url), "utf8");
  const renderer = readFileSync(new URL("../local-processor/render-video-v2.mjs", import.meta.url), "utf8");
  assert.match(tracker, /joint_visible = tracked_ball and active_ball_linked/);
  assert.match(tracker, /if not pitch_people:/);
  assert.match(tracker, /camera_ownership_phase/);
  assert.match(renderer, /const sceneZoom = 1/);
  assert.match(renderer, /const targetRatio = outputWidth \/ outputHeight/);
  assert.doesNotMatch(renderer, /actionHeight|pad=\$\{outputWidth\}:\$\{outputHeight\}/);
  assert.doesNotMatch(renderer, /\]xfade=transition=/);
  assert.match(renderer, /Scene-local[\s\S]*frame-exact cuts/);
  assert.match(tracker, /record\["player_track_id"\] == highlight_track_id/);
  assert.match(tracker, /record\["possession"\]/);
  assert.match(tracker, /and record\["joint_fit"\]/);
  assert.match(tracker, /if last_ball is None:/);
  assert.match(tracker, /proximity <= MAX_POSSESSION_DISTANCE/);
  assert.match(tracker, /smoothed_x_targets = smooth_camera/);
  assert.match(tracker, /camera_x = constrained_camera\(/);
  assert.match(tracker, /smoothed_x_targets, records/);
  assert.match(tracker, /for _ in range\(8\)/);
  assert.match(tracker, /instead of snapping/);
  assert.match(tracker, /MAX_VISIBLE_BALL_DIAMETER = 70\.0/);
  assert.match(tracker, /style = "arrow" if confidence >= 0\.58 else "none"/);
  assert.match(tracker, /"maxDirectBallGap"/);
  assert.match(tracker, /"version": 80/);
  assert.match(tracker, /active is None and phase in \{"setup", "contact"\}/);
  assert.match(tracker, /camera_active = active if/);
  assert.match(tracker, /adaptive_scene_zoom/);
  assert.doesNotMatch(tracker, /nearby = sorted\(tactical_people/);
  assert.match(tracker, /A pre-contact identity lock is stable, not irreversible/);
  assert.match(tracker, /stale origin lock immediately/);
  assert.match(tracker, /lock ownership only after the/);
  assert.match(tracker, /Back-propagate that verified scorer/);
  assert.match(tracker, /def adaptive_sample_rate/);
  assert.match(tracker, /--coarse-sample-fps/);
  assert.match(tracker, /--device/);
  assert.match(tracker, /content_fingerprint\(args\.source\)/);
  assert.match(tracker, /def phase_camera_targets/);
  assert.match(tracker, /goal_action_complete = bool/);
  assert.match(tracker, /"goalOriginCoverage"/);
  assert.match(tracker, /"goalFlightCoverage"/);
  assert.match(tracker, /create_ring/);
  assert.doesNotMatch(tracker, /create_spotlight/);
  assert.match(tracker, /def pitch_support/);
  assert.match(tracker, /nearestOnPitchPlayerDistance/);
  assert.match(tracker, /allow_handoff/);
  assert.match(tracker, /origin_track_id/);
  assert.match(tracker, /maximum_acceleration/);
  assert.match(tracker, /scorer_handoff/);
  assert.match(tracker, /select_scorer_track_id\(records, contact_time\)/);
  assert.match(tracker, /--ball-model/);
  assert.match(tracker, /FOOTBALL_BALL_CLASS = 0/);
  assert.match(tracker, /5\.5 \* point_distance/);
  assert.match(tracker, /select_stable_action_track_id/);
  assert.match(tracker, /Never guess a scorer/);
  assert.match(tracker, /goal payoff is the continued verified/);
  assert.match(tracker, /tracked_ball = last_ball is not None/);
  assert.match(tracker, /nearest_to_ball = min/);
  assert.match(tracker, /frameable_people =/);
  assert.match(tracker, /not incumbent_frameable/);
  assert.match(tracker, /velocity_decay = 0\.62 if goal_mode else 0\.76/);
  assert.match(tracker, /predicted = gap_guidance.get\(frame_number\)/);
  assert.doesNotMatch(tracker, /goal_search_expired = bool/);
  assert.match(tracker, /ball_path = choose_trajectory/);
  assert.match(tracker, /resolved_goal_hold = bool/);
  assert.match(tracker, /candidate_ball if candidate_ball is not None/);
  assert.match(tracker, /"cameraStepP95"/);
  assert.match(tracker, /"cameraJerkP95"/);
  assert.match(tracker, /"cueTime": round\(first\["time"\]/);
  assert.doesNotMatch(tracker, /create_ball_ring|"ball": output_path\.parent/);
  assert.doesNotMatch(renderer, /ballInputs|markerPaths.*ball|ballAsset/);
  assert.match(renderer, /moment\.effect === "freeze_analysis" \? "ring" : "arrow"/);
  assert.doesNotMatch(renderer, /freezeSource|freezePlayer/);
  assert.match(renderer, /frame\.value !== frames\[index - 1\]\.value/);
  assert.doesNotMatch(renderer, /targetDuration - total - cueDuration/);
  assert.match(renderer, /tpad=stop_mode=clone:stop_duration=.*requestedDuration/);
});

test("Gemini receives granular video sampling and the football phase brief", () => {
  const server = readFileSync(new URL("../local-processor/server.mjs", import.meta.url), "utf8");
  assert.match(server, /videoMetadata: \{ fps: analysisFps \}/);
  assert.match(server, /Math\.round\(startTime \* 1000\).*Math\.round\(duration \* 1000\)/s);
  assert.match(server, /footballObservationContract\(\)/);
  assert.match(server, /trackingBrief: normalizeTrackingBrief/);
  assert.match(server, /videoMetadata: \{ fps: 4 \}/);
  assert.match(server, /"fps=4,scale=-2:360"/);
});

test("tactical freeze is rendered as a held frame with synchronized keyframes", () => {
  const renderer = readFileSync(new URL("../local-processor/render-video-v2.mjs", import.meta.url), "utf8");
  const skill = readFileSync(new URL("../local-processor/football-editor-skill.mjs", import.meta.url), "utf8");
  assert.ok(renderer.includes("loop=loop=${freeze.frames}:size=1:start=${freeze.frame}"));
  assert.match(renderer, /freeze\.outputTime \+ freeze\.duration/);
  assert.match(renderer, /moment\.effect === "freeze_analysis"/);
  assert.match(skill, /Cosmetic changes alone do not create a new purpose/i);
  assert.match(skill, /Never claim that an effect guarantees fair use/i);
});

test("verified pass analysis adds a frame-tracked live network before the freeze", () => {
  const renderer = readFileSync(new URL("../local-processor/render-video-v2.mjs", import.meta.url), "utf8");
  const motion = readFileSync(new URL("../local-processor/moving-tactical-overlay.py", import.meta.url), "utf8");
  const policy = readFileSync(new URL("../local-processor/editorial-policy.mjs", import.meta.url), "utf8");
  assert.match(renderer, /moving-tactical-overlay\.py/);
  assert.match(renderer, /motionTacticalInputs/);
  assert.match(renderer, /tacticalInputs\.delete\(index\)/);
  assert.match(renderer, /eof_action=pass:shortest=0/);
  assert.match(motion, /carrierTrackId/);
  assert.match(motion, /receiverTrackId/);
  assert.match(motion, /scene_cut/);
  assert.match(policy, /live white player-to-player network/);
});

test("renderer retimes a selected decisive action before applying its minimum-duration filter", () => {
  const renderer=readFileSync(new URL("../local-processor/render-video-v2.mjs",import.meta.url),"utf8");
  assert.match(renderer,/const ordered = moments\s+\.map\(ensureMinimumSelectedDuration\)\s+\.filter/);
  assert.match(renderer,/playbackRate: Math\.min\(Number\(moment\.playbackRate \|\| 1\), playbackRate\)/);
});
test("render retry follows the same validation and AI review path", () => {
  const server = readFileSync(new URL("../local-processor/server.mjs", import.meta.url), "utf8");
  const resumeStart = server.indexOf("async function resumeRender");
  const resumeEnd = server.indexOf("async function loadSavedSpeech", resumeStart);
  const resume = server.slice(resumeStart, resumeEnd);
  assert.match(resume, /validateRenderedVideo\(outputPath, job\.settings\)/);
  assert.match(resume, /reviewRenderedVideoWithGemini/);
  assert.match(resume, /renderValidation/);
  assert.match(resume, /qualityReview/);
  assert.match(resume, /verifyCandidateSemanticsWithGemini/);
  assert.match(resume, /complete contact, ball flight and payoff boundaries/);
  assert.match(resume, /playable export was preserved instead of failing the job/);
});

test("locked scenes use bounded parallel repair and reactions cannot carry markers", () => {
  const server = readFileSync(new URL("../local-processor/server.mjs", import.meta.url), "utf8");
  const renderer = readFileSync(new URL("../local-processor/render-video-v2.mjs", import.meta.url), "utf8");
  assert.match(server, /Stored semantic reviews contain absolute source times/);
  assert.match(server, /sceneSelectionApproved === true/);
  assert.match(server, /verifiedReplayEvents\.has\(moment\.eventType\)/);
  assert.match(server, /trackFootball\(sourcePath, \[\{ \.\.\.scene, selectedForFinalVideo: true \}\]/);
  assert.match(server, /passed \$\{nativeLandscape \? "native-frame action" : "9:16 keyframe"\} verification/);
  assert.match(server, /const trackingOnlyRetry = reusableCandidates/);
  assert.match(server, /\["tracking", "writing_content", "aligning", "generating_commentary", "rendering", "completed"\]\.includes\(job\.stage\)/);
  assert.match(server, /resumeTrackingOnly/);
  assert.match(server, /const savedTracking = JSON\.parse/);
  assert.match(server, /cachedAssessment\.usable/);
  assert.match(server, /tracking-partial-\$\{requestId\}\.json/);
  assert.match(server, /Parallel scene results are being merged in source order/);
  assert.match(server, /trackingSceneConcurrency/);
  assert.match(server, /trackingEvidenceQuality\(scene, partialEvidence, nativeLandscape\) >= trackingEvidenceQuality\(scene, currentEvidence, nativeLandscape\)/);
  assert.match(server, /coarseSampleFps: Math\.min\(5, trackingCoarseSampleFps\)/);
  assert.match(server, /ballImageSize: 1600, imageSize: trackingImageSize/);
  assert.doesNotMatch(server, /eligibleForTrackingReconsideration/);
  assert.match(server, /playerHighlight: !reaction/);
  assert.match(renderer, /const playerEligible = !reaction/);
});
test("new jobs use AI-selected duration with a 30 second minimum", () => {
  const server = readFileSync(new URL("../local-processor/server.mjs", import.meta.url), "utf8");
  const studio = readFileSync(new URL("../app/video-studio.tsx", import.meta.url), "utf8");
  const skill = readFileSync(new URL("../local-processor/football-editor-skill.mjs", import.meta.url), "utf8");
  assert.match(studio, /Adaptive highlight length/);
  assert.doesNotMatch(studio, /60–70s|70–80s|80–90s|setDuration/);
  assert.match(server, /fitContinuousNarrationToLockedTimeline/);
  assert.match(server, /applyNarrationToLockedVisualTimeline/);
  assert.match(server, /selected = applyNarrationToLockedVisualTimeline\(selected, contentPlan\)/);
  assert.doesNotMatch(server, /const beatsById = new Map/);
  assert.match(server, /const selectedById = new Map/);
  assert.doesNotMatch(server, /const allById = new Map/);
  assert.match(server, /selectedById\.has\(evidenceId\)/);
  assert.match(server, /assignedBeats\.add\(beat\)/);
  assert.doesNotMatch(server, /const remainingBeats = beats\.filter/);
  assert.match(server, /plannedMoments = applyNarrationToLockedVisualTimeline\(plannedMoments, job\.editPlan\)/);
  assert.match(server, /originalSavedPlan = applyNarrationToLockedVisualTimeline\(originalSavedPlan, job\.editPlan\)/);
  assert.match(server, /selectionLocked is the Step-1 editorial contract/);
  assert.match(server, /moment\.selectionLocked === true\s*\? \{ \.\.\.moment, selectedForFinalVideo: true \}/);
  assert.match(server, /const rawContainsScene = rawLockedEvidence/);
  assert.match(server, /exact-end matching must not turn that into no evidence/);
  assert.match(server, /trackingEvidenceQuality\(moment, savedEvidence\) > trackingEvidenceQuality\(moment, freshEvidence\)/);
  assert.match(server, /await writeFile\(savedTrackingPath, JSON\.stringify\(merged\)\)/);
  assert.doesNotMatch(server, /new Map\(narratable\.map\(\(moment, index\) => \[moment\.id, beats\[index\]/);
  assert.match(readFileSync(new URL("../local-processor/editorial-policy.mjs", import.meta.url), "utf8"), /captionText: normalizeCaptionHeadline\(beat\?\.captionText, beat\?\.role\)/);
  assert.match(server, /function atempoChain\(tempo\)/);
  assert.match(server, /let selectedDuration = selectedTimelineDuration\(selected\)/);
  assert.match(server, /atempo=/);
  assert.match(server, /outside the selected/);
  assert.match(server, /automaticDurationSettings/);
  assert.doesNotMatch(server, /chooseAutomaticStoryWithGemini/);
  assert.match(skill, /minimum of 60 seconds/i);
  assert.match(skill, /measured synthesized speech/i);
});

test("automatic story length comes from verified selection, not a fixed preset", () => {
  assert.deepEqual(automaticDurationSettings(), { durationMode: "auto", targetDuration: 30, durationMin: 30 });
  assert.deepEqual(adaptiveHighlightDurationBounds(240), { minimum: 30, maximum: 90 });
  assert.deepEqual(adaptiveHighlightDurationBounds(360), { minimum: 30, maximum: 120 });
  assert.deepEqual(adaptiveHighlightDurationBounds(600), { minimum: 30, maximum: 240 });
  assert.deepEqual(adaptiveHighlightDurationBounds(1020), { minimum: 30, maximum: 300 });
  const candidates = Array.from({ length: 5 }, (_, index) => ({ id: `c${index}`, startTime: index * 15, endTime: index * 15 + 10, eventType: "shot_on_target" }));
  const candidateIds = candidates.map((candidate) => candidate.id);
  assert.equal(validateAutomaticStory({ candidateIds, targetDuration: 42 }, candidates).targetDuration, 42);
  assert.equal(validateAutomaticStory({ candidateIds, targetDuration: 57 }, candidates).targetDuration, 57);
  assert.throws(() => validateAutomaticStory({ candidateIds, targetDuration: 57 }, candidates, undefined, 50), /capacity/);
  assert.throws(() => validateAutomaticStory({ candidateIds: ["c1", "c0", "c2", "c3", "c4"], targetDuration: 42 }, candidates), /chronological/);
  assert.throws(() => validateAutomaticStory({ candidateIds, targetDuration: 29.9 }, candidates), /at least 30/);
  assert.throws(() => validateAutomaticStory({ candidateIds, targetDuration: 90 }, candidates), /capacity/);
  assert.throws(() => validateAutomaticStory({ candidateIds: ["unknown"], targetDuration: 30 }, candidates), /verified candidate IDs/);
  assert.throws(() => validateAutomaticStory({ candidateIds: ["c0", "c0"], targetDuration: 30 }, candidates), /distinct/);
  assert.match(automaticStoryPrompt(), /NOT chosen a duration/);
  assert.match(automaticStoryPrompt(120), /must not exceed 120 seconds/);
  const completeCandidates = [...candidates, { id: "c5", startTime: 75, endTime: 85, eventType: "shot_on_target" }];
  const completeIds = completeCandidates.map((candidate) => candidate.id);
  assert.throws(() => validateAutomaticStory({ candidateIds: completeIds, targetDuration: 59.9 }, completeCandidates, undefined, 240, 60), /at least 60/);
  assert.equal(validateAutomaticStory({ candidateIds: completeIds, targetDuration: 60 }, completeCandidates, undefined, 240, 60).targetDuration, 60);
  assert.match(automaticStoryPrompt(240, 60), /AT LEAST 60 seconds/);
});

test("automatic prompts and renderer do not stretch to an estimated target", () => {
  const input = { durationMode: "auto", sourceDuration: 500, targetDuration: 42, expectedBeatCount: 5 };
  assert.match(buildContentWritingPrompt(input), /not a user-imposed deadline/);
  assert.match(buildEvidenceAlignmentPrompt(input), /No finishing pass will invent or duplicate a replay/);
  const renderer = readFileSync(new URL("../local-processor/render-video-v2.mjs", import.meta.url), "utf8");
  assert.match(renderer, /settings\.editStyle === "complete_highlights" \|\| settings\.durationMode === "auto"/);
  assert.match(renderer, /settings.durationMode === "auto" \? Infinity/);
});

test("renderer uses uppercase motion captions and phase-timed editorial accents", () => {
  const renderer = readFileSync(new URL("../local-processor/render-video-v2.mjs", import.meta.url), "utf8");
  assert.match(conciseCaption("the decisive touch"), /^THE DECISIVE TOUCH$/);
  assert.match(renderer, /function safeCaptionY/);
  assert.match(renderer, /const progress = .*min\(1,max\(0/);
  assert.match(renderer, /function eventCueWindow/);
  assert.match(renderer, /payoffStartTime/);
  assert.match(renderer, /outcomeEvent && !verifiedOutcomeCue \? null/);
  assert.match(renderer, /return trackedPositionExpression\(keyframes, field, fallback\)/);
  assert.doesNotMatch(renderer, /while \(values\.length > 24\)/);
  assert.doesNotMatch(renderer, /contextBgRaw|layoutMode === "context"|boxblur=24:12/);
  assert.match(renderer, /crop=ih\*\$\{targetRatio\.toFixed\(8\)\}\/\$\{sceneZoom\.toFixed\(4\)\}:ih\/\$\{sceneZoom\.toFixed\(4\)\}/);
});

test("short-form captions are sparse complete headlines, never chopped narration", () => {
  assert.equal(conciseCaption("INSIDE FROM THE"), "");
  assert.equal(normalizeCaptionHeadline("INSIDE FROM THE", "analysis"), "WHY IT WORKED");
  assert.equal(normalizeCaptionHeadline("A caption that is far too long to fit safely", "turn"), "MOMENTUM SHIFTS");
  assert.equal(normalizeCaptionHeadline("ON TARGET", "analysis"), "ON TARGET");
  assert.equal(conciseCaption("A long subtitle sentence that should not be chopped"), "");
  const cues = sparseCaptionCues({ eventType: "goal", commentary: "Ferran Torres runs inside from the right.", onScreenText: "SPACE TO SHOOT" }, 9, {start:7,end:7.6,verified:true});
  assert.equal(sparseCaptionCues({eventType:"goal",onScreenText:"SPACE TO SHOOT"},9,7).length,1);
  assert.equal(cues.length, 2);
  assert.ok(cues.reduce((sum,cue)=>sum+cue.end-cue.start,0)<3);
  assert.ok(cues.every(cue=>!cue.text.includes("TORRES")));
  assert.deepEqual(sparseCaptionCues({eventType:"celebration"},3),[]);
  const ass=captionAss(cues);
  assert.match(ass,/FFFFFF/);
  assert.match(ass,/004DD8FF/);
  assert.match(ass,/\\move/);
  assert.doesNotMatch(ass,/62D8FF/);
});

test("reactions are short, and narration identity guards reject unverified names", () => {
  const source=[{startTime:20,endTime:27,eventType:"celebration",playbackRate:.8}];
  const [reaction]=shortReactionCandidates(source);
  assert.equal(reaction.endTime,23);
  assert.equal(reaction.playbackRate,1);
  assert.equal(source[0].endTime,27);
  assert.ok(obviousIdentityProblems("Ferran Torres scores for PSG.").length>=2);
  assert.deepEqual(obviousIdentityProblems("The winger waits for the defender to turn."),[]);
  assert.deepEqual(unverifiedNamedEntities(["home side","the winger","striker","Ferran Torres","PSG","striker Ferran Torres"]),["Ferran Torres","PSG","striker Ferran Torres"]);
});

test("finished exports require measured loudness and scene-by-scene quality evidence", () => {
  const server=readFileSync(new URL("../local-processor/server.mjs",import.meta.url),"utf8");
  const renderer=readFileSync(new URL("../local-processor/render-video-v2.mjs",import.meta.url),"utf8");
  assert.match(server,/const authoredText = selectedMoments/);
  assert.match(server,/issues.length === 0/);
  assert.match(server,/observations.length < \(viral \? 1 : 2\)/);
  assert.match(renderer,/loudnorm=I=-15:TP=-2.0/);
  assert.match(renderer,/older final\.mp4 must never satisfy validation/);
  assert.doesNotMatch(renderer,/result = await measure\(outputPath\);\s*const existing/);
  assert.match(server,/Re-normalizing the saved final audio mix without re-encoding video/);
  assert.match(renderer,/measured_I=/);
  assert.match(renderer,/speechDuration > baseOutputLength \+ 0.35/);
  assert.match(renderer,/const teaserDuration = teaserEnabled \? Math.min\(0.8, firstPayoff.end - firstPayoff.start\)/);
});

test("complete recaps use a 60-second floor without padding to a two-minute guide", () => {
  const server = readFileSync(new URL("../local-processor/server.mjs", import.meta.url), "utf8");
  const renderer = readFileSync(new URL("../local-processor/render-video-v2.mjs", import.meta.url), "utf8");
  assert.match(server, /durationMode: "requested", targetDuration: requestedTarget, durationMin: 60/);
  assert.match(server, /Math\.min\(requestedGuide, editableDuration\)/);
  assert.match(server, /requiredPlannedDuration = Number\(job\.settings\.durationMin \|\| 60\)/);
  assert.match(server, /isCompleteHighlights\(job\.settings\) \? planningCeiling\(job\.settings\) : job\.settings\.targetDuration/);
  assert.match(renderer, /settings\.editStyle === "complete_highlights" \|\| settings\.durationMode === "auto"/);
});

test("complete highlights use a grounded analysis-first recap contract", () => {
  const context = {
    status: "verified", homeTeam: "Northbridge FC", awayTeam: "Riverside AFC", finalScore: "2-1",
    goals: [{ scorer: "Adrian Vale", team: "Northbridge FC", minute: "12" }, { scorer: "Marco Dalen", team: "Riverside AFC", minute: "40" }, { scorer: "Elias Moreno", team: "Northbridge FC", minute: "75" }],
    sources: [{ uri: "https://one.example/report" }, { uri: "https://two.example/report" }],
  };
  const prompt = buildContentWritingPrompt({ durationMode: "auto", sourceDuration: 420, targetDuration: 60, evidenceSlotCount: 8, verifiedGoalActionCount: 3, completeHighlights: true, matchContext: context });
  assert.match(prompt, /analysis-first match recap/i);
  assert.match(prompt, /complete incident clusters by tactical importance/i);
  assert.match(prompt, /cover every verified goal exactly once/i);
  assert.match(prompt, /why the result happened/i);
  assert.match(prompt, /externally grounded match context/i);
  assert.match(prompt, /Do not narrate celebration gestures/i);
  assert.match(matchResearchPrompt({ sourceName: "Arsenal v Chelsea.mp4", verifiedGoalCount: 3, observedIncidents: [], currentDate: "2026-09-07" }), /two independent reliable reports/i);
});

test("a natural-language recap request controls length without becoming identity evidence", () => {
  const brief = "Create a 2-minute recap of Rennes vs PSG 2-2, covering every goal.";
  const prompt = buildContentWritingPrompt({ durationMode: "requested", sourceDuration: 420, targetDuration: 120, evidenceSlotCount: 12, verifiedGoalActionCount: 4, completeHighlights: true, recapBrief: brief });
  const research = matchResearchPrompt({ sourceName: "sample_video.mp4", recapBrief: brief, verifiedGoalCount: 4, observedIncidents: [], currentDate: "2026-09-07" });
  assert.match(prompt, /user requested this recap/i);
  assert.match(prompt, /approximately 120 seconds/i);
  assert.match(prompt, /fixture names and scores as untrusted/i);
  assert.match(prompt, /title must be a compelling 5-10-word video headline/i);
  assert.match(research, /untrusted recap request/i);
  assert.match(research, /search hint, never as identity or score evidence/i);
  assert.ok(contentPlanProblems({ title: "Too short", contentScript: "one two three", contentBeats: [] }, 30, 1, 0, "requested", true).includes("recap_title_must_have_5_to_10_words"));
});

test("studio sends the recap brief and displays the generated video title", () => {
  const studio = readFileSync(new URL("../app/video-studio.tsx", import.meta.url), "utf8");
  const server = readFileSync(new URL("../local-processor/server.mjs", import.meta.url), "utf8");
  assert.match(studio, /Setting label="Recap request"/);
  assert.match(studio, /recapBrief, targetDuration/);
  assert.match(studio, /<h1>\{videoTitle\}<\/h1>/);
  assert.match(server, /requestedRecapSeconds\(recapBrief\)/);
  assert.match(server, /durationMode: "requested"/);
  assert.match(server, /applyCompleteDurationBounds/);
  assert.match(server, /const naturalMinimum = Math.min\(60, bounds.maximum\)/);
  assert.doesNotMatch(server, /durationMode: "narration_fitted"/);
  assert.match(server, /The visual edit is locked\. Recording narration as the final production stage/);
  assert.match(server, /fitContinuousNarrationToLockedTimeline\(masterTtsFiles, selectedDuration/);
  assert.match(server, /if \(ratio < 0\.94\)/);
  assert.match(server, /targetDuration - 0\.25/);
  assert.match(server, /atempoChain\(fitRatio\)/);
  assert.match(server, /voiceTimingShortfall = true/);
  assert.match(server, /const correctionTarget = selectedDuration/);
  assert.match(server, /recoverLockedNarrationPlan\(job\.editPlan, job\.moments\)/);
  assert.match(server, /authoritativeSavedNarration\(job\.editPlan, job\.moments\)/);
  assert.match(server, /item\?\.momentId === "__continuous_master__"/);
  assert.match(server, /contentBeats: contentPlan\.contentBeats/);
  assert.match(server, /contentScript: contentPlan\.contentScript/);
  assert.doesNotMatch(server, /const ratio = duration \/ Math.max\(1, target\)/);
  assert.match(server, /title: contentPlan\.title/);
  assert.match(server, /authored narration and captions are supplied here for identity auditing/);
});
test("match identity fails closed unless sources, score and local goal count agree", () => {
  const raw = { matchFound: true, confidence: .96, homeTeam: "Northbridge FC", awayTeam: "Riverside AFC", finalScore: "2-1", competition: "League", matchDate: "2026-09-07", goals: [
    { scorer: "Adrian Vale", team: "Northbridge FC", minute: "12" }, { scorer: "Marco Dalen", team: "Riverside AFC", minute: "40" }, { scorer: "Elias Moreno", team: "Northbridge FC", minute: "75" },
  ] };
  const sources = [{ title: "Official", uri: "https://official.example/report" }, { title: "Independent", uri: "https://news.example/report" }];
  const verified = normalizeMatchContext(raw, sources, 3);
  assert.equal(verified.status, "verified");
  assert.deepEqual(verifiedIdentityNames(verified), ["Northbridge FC", "Riverside AFC", "Adrian Vale", "Marco Dalen", "Elias Moreno"]);
  assert.equal(scoreClaimIsVerified("2–1", verified), true);
  assert.equal(normalizeMatchContext(raw, sources.slice(0, 1), 3).status, "unverified");
  assert.equal(normalizeMatchContext(raw, sources, 2).status, "unverified");
  assert.equal(normalizeMatchContext({ ...raw, goals: raw.goals.map((goal, index) => ({ ...goal, scorer: `Player ${index + 1}` })) }, sources, 3).status, "unverified");
  assert.equal(normalizeMatchContext({
    ...raw,
    goals: raw.goals.map((goal, index) => ({ ...goal, team: index === 0 ? raw.homeTeam : raw.awayTeam })),
  }, sources, 3).status, "unverified", "the scorer-team totals must match the 2-1 score");
  assert.equal(normalizeMatchContext({
    ...raw,
    goals: raw.goals.map((goal, index) => index === 2 ? { ...goal, team: "Third Club" } : goal),
  }, sources, 3).status, "unverified", "every scorer must belong to one of the two verified fixture teams");
  assert.deepEqual(unverifiedNamedEntities(["Northbridge FC", "Unknown FC"], verifiedIdentityNames(verified)), ["Unknown FC"]);
  assert.deepEqual(obviousIdentityProblems("Stade Rennais FC and Paris Saint-Germain FC", ["Stade Rennais FC", "Paris Saint-Germain FC"]), []);
  assert.ok(obviousIdentityProblems("Unknown Player joins Paris Saint-Germain FC", ["Paris Saint-Germain FC"]).some((problem) => problem.includes("Unknown Player")));
});

test("verified player names are bound to the correct chronological goal incident", () => {
  const raw = { matchFound: true, confidence: .97, homeTeam: "Northbridge FC", awayTeam: "Riverside AFC", finalScore: "2-1", goals: [
    { scorer: "Adrian Vale", team: "Northbridge FC", minute: "12", assist: "Noah Mercer", opposingGoalkeeper: "Tomas Varga" },
    { scorer: "Marco Dalen", team: "Riverside AFC", minute: "40", assist: "", opposingGoalkeeper: "Leon Hart" },
    { scorer: "Elias Moreno", team: "Northbridge FC", minute: "75", assist: "Julian Cross", opposingGoalkeeper: "Tomas Varga" },
  ] };
  const sources = [{ title: "Official", uri: "https://official.example/report" }, { title: "Independent", uri: "https://news.example/report" }];
  const context = normalizeMatchContext(raw, sources, 3);
  const candidates = [
    { id: "goal-a", storyId: "story-a", eventType: "goal", startTime: 10, actionComplete: true, semanticVerified: true },
    { id: "reaction-a", storyId: "story-a", eventType: "celebration", startTime: 14, actionComplete: true, semanticVerified: true },
    { id: "goal-b", storyId: "story-b", eventType: "goal", startTime: 30, actionComplete: true, semanticVerified: true },
    { id: "goal-c", storyId: "story-c", eventType: "goal", startTime: 50, actionComplete: true, semanticVerified: true },
  ];
  const bindings = bindVerifiedIdentitiesToIncidents(context, candidates);
  assert.deepEqual(bindings.map((binding) => [binding.candidateId, binding.scorer, binding.assist]), [
    ["goal-a", "Adrian Vale", "Noah Mercer"],
    ["goal-b", "Marco Dalen", ""],
    ["goal-c", "Elias Moreno", "Julian Cross"],
  ]);
  assert.deepEqual(identityBindingProblems([
    { beatId: "one", evidenceNeed: "goal-a", narration: "Adrian Vale finishes after Noah Mercer releases him.", captionText: "VALE SCORES" },
    { beatId: "two", evidenceNeed: "goal-b", narration: "Marco Dalen finishes beyond Leon Hart.", captionText: "DALEN LEVELS" },
    { beatId: "three", evidenceNeed: "goal-c", narration: "Julian Cross finds Elias Moreno for the winner.", captionText: "MORENO WINS" },
  ], candidates, context), []);
  assert.ok(identityBindingProblems([
    { beatId: "wrong", evidenceNeed: "goal-a", narration: "Elias Moreno scores.", captionText: "MORENO SCORES" },
  ], candidates, context).some((problem) => problem.includes("player_identity_bound_to_wrong_incident")));
  assert.ok(identityBindingProblems([
    { beatId: "missing", evidenceNeed: "goal-a", narration: "The striker scores.", captionText: "WHAT A FINISH" },
  ], candidates, context).some((problem) => problem.includes("verified_scorer_missing_from_goal_beat")));
});

test("continuous analysis marker follows sustained ball carriers and drops uncertain samples", () => {
  const safe = (time, playerTrackId, actionPhase = "setup") => ({
    time, actionPhase, markerVisible: 1, directBall: true, ballInFrame: true, playerInFrame: true,
    jointFit: 1, subjectConfidence: 0.84, playerCenterX: 500 + time * 20,
    playerCenterY: 620, playerTopY: 470, playerTrackId,
  });
  const frames = [safe(0, 7), safe(0.1, 7), safe(0.2, 7), safe(0.3, 12, "flight"), safe(0.4, 12, "flight"), safe(0.5, 12, "payoff"), {
    ...safe(0.6, 12), directBall: false, jointFit: 0,
  }];
  const marked = activePlayerOverlayFrames({ eventType: "assist" }, frames);
  assert.deepEqual(marked.map((frame) => frame.analysisMarkerVisible), [1, 1, 1, 1, 1, 1, 0]);
  assert.deepEqual(analysisOverlayWindow(marked, 2), { start: 0, end: 0.62 });
  assert.equal(analysisAnnotationForMoment({ eventType: "assist" }, null, marked).style, "ring");
  assert.ok(Math.abs(marked[1].playerCenterX - marked[0].playerCenterX) < Math.abs(frames[1].playerCenterX - frames[0].playerCenterX));
});

test("moving player highlight rejects an unconfirmed two-sample possession handoff", () => {
  const safe = (time, playerTrackId) => ({
    time, actionPhase: "flight", markerVisible: 1, directBall: true, ballInFrame: true,
    playerInFrame: true, jointFit: 1, subjectConfidence: 0.88,
    playerCenterX: 520, playerCenterY: 610, playerTopY: 460, playerTrackId,
  });
  const marked = activePlayerOverlayFrames({ eventType: "assist" }, [
    safe(0, 4), safe(.1, 4), safe(.2, 4), safe(.3, 9), safe(.4, 9),
  ]);
  assert.deepEqual(marked.map((frame) => frame.analysisMarkerVisible), [1, 1, 1, 0, 0]);
});

test("goal marker stays scorer-only and exact labels require verified identity", () => {
  const frames = [0, 0.1, 0.2].map((time) => ({
    time, markerVisible: 1, actionPhase: "contact", directBall: true,
    ballInFrame: true, playerInFrame: true, jointFit: 1, subjectConfidence: 0.9,
    playerCenterX: 540, playerCenterY: 640, playerTrackId: 17,
  }));
  assert.deepEqual(
    activePlayerOverlayFrames({ eventType: "goal" }, frames).map((frame) => frame.analysisMarkerVisible),
    [1, 1, 1],
  );
  assert.deepEqual(activePlayerOverlayFrames({ eventType: "goal" }, [
    frames[0], { ...frames[1], directBall: false }, frames[2],
  ]).map((frame) => frame.analysisMarkerVisible), [0, 0, 0]);
  assert.equal(verifiedPlayerLabel({ eventType: "goal", verifiedIdentity: { scorer: "João Pedro" } }), "JOÃO PEDRO");
  assert.equal(verifiedPlayerLabel({ eventType: "goal" }), "");
  assert.equal(verifiedPlayerLabel({ eventType: "assist", verifiedIdentity: { scorer: "João Pedro" } }), "");
});

test("a verified post-goal reaction forces live-action recovery before scene lock", () => {
  const server = readFileSync(new URL("../local-processor/server.mjs", import.meta.url), "utf8");
  assert.match(server, /const reactionOnlyGoalStories = orphanGoalReactionStories\(candidates\)/);
  assert.match(server, /reactionOnlyGoalStories\.length > 0/);
  assert.match(server, /Search the preceding 45 source seconds for the distinct complete LIVE scoring action/);
  assert.match(server, /do not use the reaction itself as goal proof/);
});

test("a rejected provisional goal forces recovery even when duration capacity is sufficient", () => {
  const server = readFileSync(new URL("../local-processor/server.mjs", import.meta.url), "utf8");
  assert.match(server, /const rejectedGoalScenes = rejectedPriorityScenes\.filter/);
  assert.match(server, /rejectedGoalScenes\.length > 0 \|\| replayOnlyGoalStories\.length > 0/);
  assert.match(server, /Replace \$\{moment\.id\} \(\$\{moment\.eventType\}\) with the complete live action/);
});

test("a late replay forces a search for a distinct intervening goal", () => {
  const server = readFileSync(new URL("../local-processor/server.mjs", import.meta.url), "utf8");
  assert.match(server, /const suspiciousLateReplays = suspiciousLateGoalReplays\(candidates\)/);
  assert.match(server, /suspiciousLateReplays\.length > 0/);
  assert.match(server, /Search the preceding 45 source seconds for a DISTINCT complete live goal/);
  assert.match(server, /subsequent scoreboard transition/);
});

test("claimed report URLs are accepted only when two trusted pages support every exact scorer", async () => {
  const research = {
    homeTeam: "Northbridge FC", awayTeam: "Riverside AFC", finalScore: "2-2",
    goals: [
      { scorer: "Adrian Vale", team: "Northbridge FC" }, { scorer: "Marco Dalen", team: "Riverside AFC" },
      { scorer: "Elias Moreno", team: "Northbridge FC" }, { scorer: "Jonas Reed", team: "Riverside AFC" },
    ],
    sources: [
      { title: "BBC report", uri: "https://www.bbc.com/sport/football/example" },
      { title: "Sky report", uri: "https://www.skysports.com/football/example" },
      { title: "Unsafe", uri: "https://127.0.0.1/private" },
    ],
  };
  const report = "Northbridge FC and Riverside AFC drew 2-2. Adrian Vale, Marco Dalen, Elias Moreno and Jonas Reed scored.";
  assert.equal(claimedResearchSources(research).length, 2);
  assert.equal(matchReportPageSupports(research, report), true);
  assert.equal(matchReportPageSupports(research, report.replace("Jonas Reed", "the final scorer")), false);
  const verified = await verifyClaimedResearchSources(research, async (uri) => ({
    ok: true,
    url: uri,
    headers: { get: () => String(report.length) },
    text: async () => report,
  }));
  assert.deepEqual(verified.map((source) => source.title), ["BBC report", "Sky report"]);
});

test("production match research locally verifies all Gemini identity sources", () => {
  const server = readFileSync(new URL("../local-processor/server.mjs", import.meta.url), "utf8");
  assert.match(server, /const groundingSources = extractGroundingSources\(response\)/);
  assert.match(server, /let sources = await verifyClaimedResearchSources/);
  assert.doesNotMatch(server, /if \(sources\.length < 2\).*verifyClaimedResearchSources/);
  assert.match(server, /if \(sources\.length < 2\) sources = \[\.\.\.sources, \.\.\.await discoverVerifiedResearchSources\(raw\)\]/);
});

test("search fallback discovers canonical reports before applying the same strict verifier", async () => {
  const research = {
    homeTeam: "Northbridge FC", awayTeam: "Riverside AFC", finalScore: "1-1",
    goals: [{ scorer: "Adrian Vale", team: "Northbridge FC" }, { scorer: "Marco Dalen", team: "Riverside AFC" }],
  };
  const resultPage = '<a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fwww.bbc.com%2Fsport%2Ffootball%2Freport">BBC</a>'
    + '<a class="result__a" href="https://www.skysports.com/football/report">Sky</a>';
  const report = "Northbridge FC and Riverside AFC drew 1-1. Adrian Vale and Marco Dalen scored.";
  const sources = await discoverVerifiedResearchSources(research, async (uri) => ({
    ok: true, url: uri, headers: { get: () => "0" }, text: async () => uri.includes("duckduckgo.com/html") ? resultPage : report,
  }));
  assert.deepEqual(sources.map((source) => new URL(source.uri).hostname), ["www.bbc.com", "www.skysports.com"]);
});

test("complete-highlight marker is one large thick red-only ring with matching anchors", () => {
  const tracker = readFileSync(new URL("../local-processor/track-football-v2.py", import.meta.url), "utf8");
  const renderer = readFileSync(new URL("../local-processor/render-video-v2.mjs", import.meta.url), "utf8");
  const server = readFileSync(new URL("../local-processor/server.mjs", import.meta.url), "utf8");
  assert.match(tracker, /"ring": \{"width": 320, "height": 320, "anchor_x": 160, "anchor_y": 160\}/);
  assert.match(tracker, /cv2\.circle\(image, \(160, 160\), 128, \(0, 0, 255, 255\), 20, cv2\.LINE_AA\)/);
  assert.doesNotMatch(tracker.slice(tracker.indexOf("def create_ring"), tracker.indexOf("def build_keyframes")), /245, 245, 255|36, 45, 240/);
  assert.match(renderer, /playerAnchorX = ring \? 160 : 80/);
  assert.match(renderer, /playerAnchorY = ring \? 160 : 176/);
  assert.match(tracker, /dynamic_track_id = \(record\.get\("player_track_id"\)/);
  assert.match(tracker, /"verified_ball_carrier"/);
  assert.match(renderer, /source\[end\]\?\.playerTrackId === trackId/);
  assert.match(renderer, /const alpha = clamp\(elapsed \* 5\.5, 0\.22, 0\.62\)/);
  assert.match(server, /continuousTimelineTreatmentCoverage/);
  assert.match(server, /verified ball carrier only; sustained handoff; hidden on uncertainty/);
  assert.match(server, /large, thick, red-only ring/i);
  assert.match(server, /attempt <= 2/);
  assert.match(server, /Execute Google Search again because the previous report URLs failed independent page-content verification/i);
});

test("Video Intelligence supplies OCR evidence before Gemini writes the recap", async () => {
  const previous = process.env.VIDEO_INTELLIGENCE_FEATURES;
  delete process.env.VIDEO_INTELLIGENCE_FEATURES;
  const { configuredVideoIntelligenceFeatures } = await import("../local-processor/google-video-intelligence.mjs");
  assert.deepEqual(configuredVideoIntelligenceFeatures(), ["SHOT_CHANGE_DETECTION", "OBJECT_TRACKING", "TEXT_DETECTION"]);
  if (previous === undefined) delete process.env.VIDEO_INTELLIGENCE_FEATURES;
  else process.env.VIDEO_INTELLIGENCE_FEATURES = previous;
  const source = readFileSync(new URL("../local-processor/google-video-intelligence.mjs", import.meta.url), "utf8");
  assert.match(source, /textAnnotations/);
  assert.match(source, /speechTranscriptions/);
  assert.match(source, /detectedText/);
});

test("script writing precedes alignment and weak tracking downgrades effects", () => {
  const server = readFileSync(new URL("../local-processor/server.mjs", import.meta.url), "utf8");
  const renderer = readFileSync(new URL("../local-processor/render-video-v2.mjs", import.meta.url), "utf8");
  const newJobFlow = server.slice(server.indexOf("async function processJob"));
  assert.ok(newJobFlow.indexOf('"writing_content"') < newJobFlow.indexOf('"aligning_content"'));
  assert.match(server, /recoverSafeStaticCandidates/);
  assert.match(renderer, /usesSafeStaticPresentation/);
  assert.match(server, /Gemini recap script/);
});

test("complete recaps downgrade missing companion footage instead of rejecting a playable export", () => {
  const server = readFileSync(new URL("../local-processor/server.mjs", import.meta.url), "utf8");
  assert.ok(server.includes("const blockingSequenceProblems = isCompleteHighlights(job.settings) ? [] : sequenceProblems;"));
  assert.ok(server.includes("const blockingPlannedSequenceProblems = isCompleteHighlights(job.settings) ? [] : plannedSequenceProblems;"));
  assert.match(server, /Complete verified goal actions were preserved without optional companion footage/);
});
