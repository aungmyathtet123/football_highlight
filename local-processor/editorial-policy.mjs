export const MIN_SCENE_SECONDS = 1.2;
export const MAX_SCENE_SECONDS = 5;

export function selectDirectorCandidates(candidates, limit = 180) {
  return [...candidates]
    .filter((candidate) => candidate.keepDecision !== "reject" && candidate.confidence >= 0.4)
    .sort((a, b) => Number(b.importanceScore || 0) - Number(a.importanceScore || 0))
    .slice(0, limit)
    .sort((a, b) => a.startTime - b.startTime);
}

export function buildWholeVideoDirectorPrompt({ sourceDuration, targetDuration, intensity, commentary }) {
  const minimumNarrationWords = Math.max(70, Math.round(targetDuration * 1.75));
  const maximumNarrationWords = Math.max(minimumNarrationWords + 12, Math.round(targetDuration * 2.25));
  return [
    "You are the whole-video story director for a professional football-analysis Short.",
    "The first-pass observation timeline covers the complete " + sourceDuration.toFixed(2) + "-second source from beginning to end. Read the entire timeline before choosing anything.",
    "Create one coherent approximately " + targetDuration + "-second, full-bleed 1080x1920 analysis. Editing intensity is " + intensity + ".",
    "Original broadcast commentary will be " + (commentary ? "fully muted and replaced by one continuous male analyst narration" : "handled by the user setting") + ".",
    "First choose exactly one analytical question and one evidence-based answer. Examples of the form, not facts to copy: Why did this goal happen? Which defensive movement opened the space? Why was the decision controversial?",
    "Select one incident/storyId. A replay or reaction may be included only when it clearly belongs to that same incident. Never fill time with unrelated goals, saves, skills, or celebrations.",
    "The opening 0-3 seconds must show the decisive proof or outcome while the narration creates an unanswered football question. Then reconstruct the setup, reveal the tactical cause, show the decisive action, use replay as proof when available, and end on the consequence or emotional payoff.",
    "Use only evidence clips between " + MIN_SCENE_SECONDS + " and " + MAX_SCENE_SECONDS + " output seconds. Split longer candidates at natural boundaries. The selected source material may initially exceed the target, but the returned final sequence must not exceed " + (targetDuration + 1) + " seconds after playback-rate changes.",
    "Every gameplay clip must visibly contain the football and the involved player in the same full-screen 9:16 crop. Reject footage that requires letterboxing, blurred panels, a ball-only crop, or a player-only crop. Player-only footage is allowed only for a short reaction or celebration payoff.",
    "Write narration as connected reasoning, not isolated captions and not play-by-play. Each beat must link to the previous beat, identify a visible clue, and explain cause, decision, space, timing, technique, or consequence. Do not repeatedly say tactical, demonstrates, replay footage, amazing, or what a goal.",
    "Across all segment commentary fields use approximately " + minimumNarrationWords + "-" + maximumNarrationWords + " words. Use a confident, conversational male football analyst style with natural punctuation and brief dramatic pauses. Never imitate a real commentator.",
    "Do not invent names, teams, scorelines, outcomes, or motives. Use a name only when the candidate evidence explicitly and reliably identifies it. If evidence is insufficient, use neutral terms such as the runner, defender, goalkeeper, or referee.",
    "Use mostly hard cuts. Add slow motion, freeze, punch zoom, annotation, color treatment, transition, sound accent, callout, or emoji only when it makes a visible analytical point. Keep one clean base grade; use replay_blue only for forensic replay and goal_gold only for a confirmed goal payoff.",
    "Return JSON only with title, editorialThesis, storyQuestion, storyAnswer, rationale, and segments.",
    "Each segment must reference exactly one candidateId and contain startTime, endTime, editOrder beginning at 0, role (hook|setup|evidence|action|proof|consequence|reaction), analysisPurpose, transitionIn (cut|crossfade|crosszoom|whip|flash), transitionDuration 0.04-0.36, effect (none|punch_zoom|slow_motion|speed_up|replay_treatment), playbackRate 0.72-1.18, playerHighlight boolean, one connected narration commentary beat, onScreenText of 2-4 words, eventCallout (none|amazing|goal|shot|save|foul|card|close|pass|celebration), colorGrade (clean|dramatic|goal_gold|replay_blue), and soundEffect (none|whoosh|impact|goal|whistle|sparkle).",
  ].join(" ");
}

export function buildContentWritingPrompt({ sourceDuration, targetDuration }) {
  const minimumWords = Math.round(targetDuration * 2.0);
  const maximumWords = Math.round(targetDuration * 2.45);
  return [
    "You are the senior football writer. The observation timeline covers the complete source from beginning to end.",
    "Read every observation before deciding the content. Do not choose timestamps or edit clips yet.",
    "Write one engaging, evidence-based football analysis designed to speak for at least " + targetDuration + " seconds.",
    "The source duration is " + sourceDuration.toFixed(2) + " seconds. The script must contain " + minimumWords + "-" + maximumWords + " words.",
    "Build a strong 0-3 second hook, a clear analytical question, connected explanation, visible evidence, tactical or technical reasoning, and a satisfying conclusion.",
    "The analysis may connect several related incidents under one clear thesis when one incident cannot support the full duration. Never join unrelated highlights merely to fill time.",
    "Write causal football insight about decisions, movement, space, timing, technique, pressure, defensive reactions, and consequences.",
    "Never use directing filler such as look at the replay, watch this, notice how, focus on, pay attention, here we see, you can see, or in this clip. Never narrate the editing process.",
    "Do not copy candidate commentary. Do not invent names, teams, scorelines, motives, or outcomes that are not supported by the observation timeline.",
    "Return JSON only with title, editorialThesis, contentAngle, storyQuestion, storyAnswer, and contentBeats.",
    "contentBeats must contain 12-20 ordered beats. Each beat needs beatId, role (hook|setup|analysis|evidence|turn|conclusion), narration of 7-18 words, evidenceNeed, and captionText of 2-4 words.",
  ].join(" ");
}

export function buildEvidenceAlignmentPrompt({ targetDuration, intensity }) {
  return [
    "You are the evidence editor. The football analysis content is already approved and must remain the authority.",
    "Do not rewrite the analysis. Map every content beat to visible evidence from the complete observation timeline.",
    "Build a " + targetDuration + "- to " + (targetDuration + 3) + "-second visual timeline. Editing intensity is " + intensity + ".",
    "Use 1.2-5.0 second clips and enough distinct clips to cover the duration. Several related incidents may support the same thesis.",
    "Every gameplay segment must show the ball and involved player together. Reaction or celebration may be player-only.",
    "Mostly use hard cuts. Use replay, speed changes, freeze, player highlight, callout, color treatment, and sound accents only when they support that content beat.",
    "Return JSON only with rationale and segments. Each segment needs candidateId, beatId, startTime, endTime, editOrder, role, analysisPurpose, transitionIn, transitionDuration, effect, playbackRate, playerHighlight, onScreenText, eventCallout, colorGrade, and soundEffect.",
    "Never output commentary or a new script. Never use a source interval outside its candidate.",
  ].join(" ");
}

export function normalizeContentPlan(raw, targetDuration) {
  const beats = (Array.isArray(raw?.contentBeats) ? raw.contentBeats : [])
    .map((beat, index) => ({
      beatId: String(beat?.beatId || "beat-" + (index + 1)).replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 48),
      role: String(beat?.role || "analysis"),
      narration: normalizeSentence(beat?.narration),
      evidenceNeed: String(beat?.evidenceNeed || "Visible football evidence supporting this point.").slice(0, 220),
      captionText: splitCaptionChunks(beat?.captionText || beat?.narration, 4)[0] || "KEY DETAIL",
    }))
    .filter((beat) => beat.narration);
  const contentScript = beats.map((beat) => beat.narration).join(" ");
  return {
    title: String(raw?.title || "Football analysis").slice(0, 100),
    editorialThesis: String(raw?.editorialThesis || "").slice(0, 360),
    contentAngle: String(raw?.contentAngle || "").slice(0, 240),
    storyQuestion: String(raw?.storyQuestion || "").slice(0, 220),
    storyAnswer: String(raw?.storyAnswer || "").slice(0, 360),
    contentBeats: beats,
    contentScript,
    targetDuration,
    wordCount: countWords(contentScript),
  };
}

export function contentPlanProblems(plan, targetDuration) {
  const problems = [];
  const minimumWords = Math.round(targetDuration * 2.0);
  const maximumWords = Math.round(targetDuration * 2.45);
  const words = countWords(plan?.contentScript);
  if (words < minimumWords) problems.push("script_too_short:" + words + "<" + minimumWords);
  if (words > maximumWords) problems.push("script_too_long:" + words + ">" + maximumWords);
  if (!plan?.editorialThesis || !plan?.storyQuestion || !plan?.storyAnswer) problems.push("missing_analysis_structure");
  if (!Array.isArray(plan?.contentBeats) || plan.contentBeats.length < 12) problems.push("too_few_content_beats");
  if (/\b(?:look at(?: the)? replay|look at|watch this|watch the replay|notice how|focus on|pay attention|here we see|here you can see|you can see|we can see|as you can see|in this clip|in the replay)\b/i.test(plan?.contentScript || "")) problems.push("directing_filler_language");
  return problems;
}

export function plannedSegmentDuration(segments) {
  return (Array.isArray(segments) ? segments : []).reduce((total, segment, index) => {
    const start = Number(segment?.startTime);
    const end = Number(segment?.endTime);
    const rate = Math.min(1.18, Math.max(0.72, Number(segment?.playbackRate || 1)));
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return total;
    const transition = index === 0 ? 0 : Math.min(0.36, Math.max(0.04, Number(segment?.transitionDuration || 0.04)));
    return total + Math.min(5, (end - start) / rate) - transition;
  }, 0);
}

function countWords(value) {
  return String(value || "").trim().split(/\s+/).filter(Boolean).length;
}

export function groupCandidatesByStory(candidates) {
  const groups = new Map();
  for (const candidate of candidates) {
    if (candidate.keepDecision === "reject") continue;
    const storyId = String(candidate.storyId || candidate.id);
    if (!groups.has(storyId)) groups.set(storyId, []);
    groups.get(storyId).push(candidate);
  }
  return groups;
}

export function strongestStoryCandidates(candidates) {
  const groups = [...groupCandidatesByStory(candidates).values()];
  if (groups.length === 0) return [];
  return groups
    .map((moments) => ({ moments, score: storyScore(moments) }))
    .sort((a, b) => b.score - a.score)[0].moments;
}

function storyScore(moments) {
  const best = [...moments]
    .sort((a, b) => Number(b.importanceScore || 0) - Number(a.importanceScore || 0))
    .slice(0, 8);
  const phases = new Set(moments.map((moment) => moment.storyPhase));
  const phaseBonus = ["build_up", "action", "payoff", "replay", "reaction"]
    .filter((phase) => phases.has(phase)).length * 18;
  const evidenceBonus = moments.filter((moment) => moment.ballVisible && moment.mainPlayerVisible).length * 8;
  return best.reduce((total, moment) => total + Number(moment.importanceScore || 0), 0) + phaseBonus + evidenceBonus;
}

export function buildContinuousNarration(moments) {
  return moments
    .filter((moment) => moment.selectedForFinalVideo && moment.commentary)
    .sort((a, b) => Number(a.editOrder) - Number(b.editOrder))
    .map((moment) => normalizeSentence(moment.commentary))
    .filter(Boolean)
    .join(" ");
}

export function assessPlannedSceneTracking(moment, evidence) {
  const reactionOnly = moment.eventType === "celebration"
    || moment.storyPhase === "reaction"
    || moment.role === "reaction";
  if (reactionOnly) return { usable: true, mode: "planned_reaction" };
  if (!evidence) return { usable: false, mode: "missing_tracking" };

  const directBall = Number(evidence.ballDetectionCoverage || 0);
  const playerCoverage = Number(evidence.playerDetectionCoverage || 0);
  const jointVisibility = Number(evidence.jointVisibilityCoverage || 0);
  const jointFit = Number(evidence.jointFitCoverage || 0);
  const maximumBallGap = Number(evidence.maxDirectBallGap ?? Number.POSITIVE_INFINITY);
  const goalPayoff = Number(evidence.goalPayoffCoverage ?? 0);
  const goalNeedsPayoff = moment.eventType === "goal";
  const payoffReady = !goalNeedsPayoff || goalPayoff >= 0.10;
  const strict = Boolean(evidence.openingJointVisible)
    && directBall >= 0.54
    && jointVisibility >= 0.54
    && jointFit >= 0.42
    && maximumBallGap <= 0.8
    && payoffReady;
  if (strict) return { usable: true, mode: "strict" };

  // Gemini watches the full source and supplies scene-level visibility evidence.
  // The local detector remains the crop validator, but a weak first sample is
  // recoverable when enough direct detections prove the player/ball relationship.
  const aiJointConfirmed = moment.ballVisible === true
    && moment.mainPlayerVisible === true
    && Number(moment.confidence || 0) >= 0.84
    && Number(moment.visualClarity || 0) >= 80;
  const locallySupported = playerCoverage >= 0.80
    && directBall >= 0.30
    && jointVisibility >= 0.30
    && jointFit >= 0.24
    && maximumBallGap <= 2.4;
  if (aiJointConfirmed && locallySupported && payoffReady) {
    return { usable: true, mode: "ai_confirmed_joint_scene" };
  }

  const replay = moment.isReplay === true || moment.storyPhase === "replay";
  if (replay && aiJointConfirmed && playerCoverage >= 0.85 && Number(moment.visualClarity || 0) >= 88 && payoffReady) {
    return { usable: true, mode: "ai_confirmed_close_replay" };
  }

  if (goalNeedsPayoff && !payoffReady) return { usable: false, mode: "missing_goal_payoff" };
  if (directBall < 0.30 || maximumBallGap > 2.4) return { usable: false, mode: "ball_not_visibly_continuous" };
  return { usable: false, mode: "insufficient_joint_framing" };
}

const tacticalEvidenceWords = new Set(["assist", "clearance", "cross", "dribble", "header", "offside", "save", "shot", "tackle", "volley"]);

const semanticStopWords = new Set([
  "the", "and", "with", "from", "into", "over", "past", "that", "this", "their", "before", "after",
  "shows", "showing", "scene", "clip", "replay", "player", "ball", "football", "toward", "towards", "through",
]);

export function semanticBackupScore(planned, candidate) {
  if (!planned || !candidate || planned.id === candidate.id) return -1;
  let score = 0;
  if (planned.storyId && planned.storyId === candidate.storyId) score += 60;
  if (planned.eventType && planned.eventType === candidate.eventType) score += 8;
  const candidateIsReaction = candidate.eventType === "celebration" || candidate.storyPhase === "reaction";
  const plannedAllowsReaction = planned.eventType === "celebration" || planned.storyPhase === "reaction" || planned.role === "reaction";
  if (candidateIsReaction && !plannedAllowsReaction) score -= 60;
  const plannedTokens = semanticTokens(planned);
  const candidateTokens = semanticTokens(candidate, true);
  for (const token of plannedTokens) {
    if (candidateTokens.has(token)) score += tacticalEvidenceWords.has(token) ? 18 : token.length >= 7 ? 10 : 6;
  }
  return score;
}

export function rankSemanticBackups(plannedMoments, candidates) {
  const planned = (plannedMoments || []).filter((moment) => moment.selectedForFinalVideo);
  return (candidates || [])
    .map((moment) => ({
      moment,
      semanticScore: Math.max(0, ...planned.map((item) => semanticBackupScore(item, moment))),
    }))
    .sort((a, b) => b.semanticScore - a.semanticScore
      || Number(b.moment.importanceScore || 0) - Number(a.moment.importanceScore || 0));
}

function normalizeSemanticToken(token) {
  if (/^clear/.test(token)) return "clearance";
  if (/^cross/.test(token)) return "cross";
  if (/^defen/.test(token)) return "defense";
  if (/^attack/.test(token)) return "attack";
  if (/^celebr/.test(token)) return "celebration";
  if (/^dribbl/.test(token)) return "dribble";
  if (/^finish/.test(token)) return "finish";
  if (/^head/.test(token)) return "header";
  if (/^sav/.test(token)) return "save";
  if (/^shoot/.test(token)) return "shot";
  if (/^tackl/.test(token)) return "tackle";
  return token.length > 4 && token.endsWith("s") ? token.slice(0, -1) : token;
}
function semanticTokens(moment, evidenceOnly = false) {
  const fields = evidenceOnly
    ? [moment.description]
    : [moment.description, moment.commentary, moment.analysisPurpose, moment.onScreenText];
  const text = fields
    .filter(Boolean)
    .join(" ")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ");
  return new Set(text.split(/\s+/)
    .map(normalizeSemanticToken)
    .filter((token) => token.length >= 4 && !semanticStopWords.has(token)));
}
export function splitCaptionChunks(value, maximumWords = 4) {
  const words = String(value || "").replace(/[\r\n]+/g, " ").trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];
  const chunks = [];
  let current = [];
  for (const word of words) {
    current.push(word);
    const punctuationBreak = /[.!?,;:]$/.test(word) && current.length >= 2;
    if (current.length >= maximumWords || punctuationBreak) {
      chunks.push(current.join(" "));
      current = [];
    }
  }
  if (current.length) {
    if (current.length === 1 && chunks.length && chunks.at(-1).split(/\s+/).length < maximumWords) {
      chunks[chunks.length - 1] += " " + current[0];
    } else {
      chunks.push(current.join(" "));
    }
  }
  return chunks;
}

function normalizeSentence(value) {
  const text = String(value || "").replace(/[\r\n]+/g, " ").replace(/\s+/g, " ").trim();
  if (!text) return "";
  return /[.!?]$/.test(text) ? text : text + ".";
}
