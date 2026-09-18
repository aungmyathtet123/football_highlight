import { conciseCaption, normalizeCaptionHeadline, shortFormWritingContract } from "./short-form-policy.mjs";
import { uniqueEvidenceCandidates } from "./automatic-duration.mjs";

export const MIN_SCENE_SECONDS = 0.5;
export const MAX_SCENE_SECONDS = 30;
export const COMPLETE_ACTION_SECONDS = 5;
export const COMPLETE_HIGHLIGHT_MAX_PLAYBACK_RATE = 1;

export function completeActionPlaybackRate(sourceLength, freezeDuration = 0) {
  const duration = Math.max(0.1, Number(sourceLength) || 0.1);
  const movingBudget = Math.max(2.5, COMPLETE_ACTION_SECONDS - Math.max(0, Number(freezeDuration) || 0));
  return Math.max(1, Math.min(COMPLETE_HIGHLIGHT_MAX_PLAYBACK_RATE, duration / movingBudget));
}

export function selectDirectorCandidates(candidates, limit = 180) {
  return uniqueEvidenceCandidates(candidates
    .filter((candidate) => candidate.selectionLocked === true || (candidate.keepDecision !== "reject" && candidate.semanticVerified !== false && candidate.confidence >= 0.4)))
    .sort((a, b) => Number(b.importanceScore || 0) - Number(a.importanceScore || 0))
    .slice(0, limit)
    .sort((a, b) => a.startTime - b.startTime);
}

export function analysisFirstIncidentOrder(candidates) {
  const groups = new Map();
  for (const moment of Array.isArray(candidates) ? candidates : []) {
    const key = String(moment.storyId || moment.incidentId || moment.id);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(moment);
  }
  const phaseRank = (moment) => moment.eventType === "celebration" || moment.storyPhase === "reaction"
    ? 2 : moment.isReplay || moment.storyPhase === "replay" ? 1 : 0;
  const chapters = [...groups.values()].map((moments) => ({
    moments: [...moments].sort((a, b) => phaseRank(a) - phaseRank(b) || Number(a.startTime) - Number(b.startTime)),
    score: Math.max(...moments.map((moment) => Number(moment.hookScore || 0) * 0.55 + Number(moment.importanceScore || 0) * 0.45)),
    sourceStart: Math.min(...moments.map((moment) => Number(moment.startTime || 0))),
  }));
  chapters.sort((a, b) => b.score - a.score || a.sourceStart - b.sourceStart);
  return chapters.flatMap((chapter) => chapter.moments);
}

export function buildWholeVideoDirectorPrompt({ sourceDuration, targetDuration, intensity, commentary }) {
  const minimumNarrationWords = Math.max(70, Math.round(targetDuration * 2.05));
  const maximumNarrationWords = Math.max(minimumNarrationWords + 12, Math.round(targetDuration * 2.25));
  return [
    "You are the whole-video story director for a professional football-analysis Short.",
    "The first-pass observation timeline covers the complete " + sourceDuration.toFixed(2) + "-second source from beginning to end. Read the entire timeline before choosing anything.",
    "Create one coherent approximately " + targetDuration + "-second football analysis. Editing intensity is " + intensity + ". Preserve the configured output frame; do not invent camera movement merely for decoration.",
    "Original broadcast commentary will be " + (commentary ? "fully muted and replaced by one continuous male analyst narration" : "handled by the user setting") + ".",
    "First choose exactly one analytical question and one evidence-based answer. Examples of the form, not facts to copy: Why did this goal happen? Which defensive movement opened the space? Why was the decision controversial?",
    "Select one incident/storyId. A replay or reaction may be included only when it clearly belongs to that same incident. Never fill time with unrelated goals, saves, skills, or celebrations.",
    "The opening 0-3 seconds must show the decisive proof or outcome while the narration creates an unanswered football question. Then reconstruct the setup, reveal the tactical cause, show the decisive action, use replay as proof when available, and end on the consequence or emotional payoff.",
    "A gameplay scene must preserve the complete action chain from the first meaningful touch through the pass sequence, shot, save, goal, turnover, whistle, or other visible result. Keep those source boundaries intact and play every action at the source's normal 1.0x speed. Never accelerate footage to meet a duration guide; let the edit run longer instead of rushing it or cutting before the result. Split only at a true possession reset, replay cut, whistle, or completed consequence. The final duration may expand to preserve complete actions at normal speed.",
    "Every gameplay clip must visibly contain the football and the involved player in the configured output frame. Player-only footage is allowed only for a short reaction or celebration payoff.",
    "Write narration as connected reasoning, not isolated captions and not play-by-play. Each beat must link to the previous beat, identify a visible clue, and explain cause, decision, space, timing, technique, or consequence. Do not repeatedly say tactical, demonstrates, replay footage, amazing, or what a goal.",
    "Across all segment commentary fields use approximately " + minimumNarrationWords + "-" + maximumNarrationWords + " words. Use a confident, conversational male football analyst style with natural punctuation and brief dramatic pauses. Never imitate a real commentator.",
    "Do not invent names, teams, scorelines, outcomes, or motives. Use a name only when the candidate evidence explicitly and reliably identifies it. If evidence is insufficient, use neutral terms such as the runner, defender, goalkeeper, or referee.",
    "Every source excerpt must be necessary to a specific criticism, explanation, or analytical claim. Use no more of the broadcast than that point needs, remove generic entertainment filler, and make the original analytical purpose obvious throughout.",
    "Give every spoken analysis beat a deliberate visual identity tied to its purpose: cool for setup or buildup, dramatic for action/evidence, replay_blue for forensic replay, goal_gold for a confirmed goal payoff, and warm for consequence or reaction. Use short black or white scene-entry transitions without overlapping or cutting off the previous action. Add slow motion, freeze, annotation, exposure change, sound accent, and callout only at verified evidence. Cosmetic alteration alone does not establish fair use.",
    "All on-screen text is uppercase and split into short two-to-four-word motion beats. Use the thick red ring only to identify the locally verified active player on moving footage. On a verified pass freeze, yellow foot rings and thin yellow connector lines may identify only visually kit-matched involved teammates, followed by one white directional arrow between the locally verified passer and receiver. Never invent a tactical relationship, spotlight, or filled halo.",
    "For every goal segment preserve the initiating player and ball, contact, ball flight, goalkeeper or goalmouth result, and only then optional celebration. A celebration cannot satisfy the goal action or hook evidence.",
    "Return JSON only with title, editorialThesis, storyQuestion, storyAnswer, rationale, and segments.",
    "Each segment must reference exactly one candidateId and contain startTime, endTime, editOrder beginning at 0, role (hook|setup|evidence|action|proof|consequence|reaction), analysisPurpose, transformationReason, transitionIn (cut|crossfade|crosszoom|whip|flash), transitionDuration 0.04-0.36, effect (none|punch_zoom|slow_motion|speed_up|replay_treatment|freeze_analysis), freezeAtPhase (contact|payoff|none), freezeDuration 0.4-1.0, playbackRate 0.72-1.18, playerHighlight boolean, one connected narration commentary beat, onScreenText of 2-4 words, eventCallout (none|amazing|goal|shot|save|foul|card|close|pass|celebration), colorGrade (cool|clean|warm|dramatic|goal_gold|replay_blue), and soundEffect (none|whoosh|impact|goal|whistle|sparkle).",
  ].join(" ");
}

export function recommendedContentBeatCount(targetDuration, evidenceSlotCount = Number.MAX_SAFE_INTEGER) {
  const durationSlots = Math.max(2, Math.round(Number(targetDuration || 0) / 7.5));
  const suppliedSlots = Number(evidenceSlotCount);
  const verifiedSlots = Number.isFinite(suppliedSlots) && suppliedSlots > 0 ? Math.floor(suppliedSlots) : durationSlots;
  return Math.max(1, Math.min(durationSlots, verifiedSlots));
}

export function buildContentWritingPrompt({ durationMode, sourceDuration, targetDuration, verifiedEvidenceDuration = targetDuration, editableEvidenceDuration = verifiedEvidenceDuration, evidenceSlotCount, verifiedGoalActionCount = 0, completeHighlights = false, matchContext = null, identityBindings = [], recapBrief = "" }) {
  const minimumWords = Math.round(targetDuration * (completeHighlights ? 3.0 : durationMode === "auto" ? 0.9 : 2.05));
  const maximumWords = Math.round(targetDuration * (completeHighlights ? 3.2 : durationMode === "auto" ? 1.55 : 2.30));
  const beatCount = recommendedContentBeatCount(targetDuration, evidenceSlotCount);
  const verifiedSlots = Number.isFinite(Number(evidenceSlotCount)) ? Math.floor(Number(evidenceSlotCount)) : beatCount;
  const verifiedDuration = Number.isFinite(Number(verifiedEvidenceDuration)) ? Number(verifiedEvidenceDuration) : targetDuration;
  const editableDuration = Number.isFinite(Number(editableEvidenceDuration)) ? Number(editableEvidenceDuration) : verifiedDuration;
  return [
    "You are the senior football writer. The observation timeline covers the complete source from beginning to end and contains only locally tracked, frameable evidence.",
    (durationMode === "auto" ? "AI selected a natural story of approximately " + targetDuration + " seconds, not a user-imposed deadline. The final video must be at least " + (completeHighlights ? 60 : 30) + " seconds. " : "The user requested approximately " + targetDuration + " seconds. ") + "The pool contains " + verifiedDuration.toFixed(1) + " seconds of unique verified source evidence and can support up to " + editableDuration.toFixed(1) + " seconds after evidence-linked slow motion, freezes, and genuine separately sourced replay angles. Write only claims that this supplied evidence can visibly support.",
    "Read every verified observation before deciding the content. Do not choose timestamps or edit clips yet.",
    "Write one continuous, engaging football recap designed to be recorded before editing and to speak naturally from the first frame through the final conclusion around " + targetDuration + " seconds, including only brief punctuation pauses. For complete highlights, 60 seconds is a hard minimum while the ending may run naturally beyond the requested guide.",
    "Use active football-recap language: short forceful sentences, vivid action verbs, rising tension before each decisive touch, and a clear consequence immediately after it. Vary sentence length and cadence. Avoid slow documentary filler such as the moment unfolds, the turning point arrives, teammates celebrate, the dramatic sequence, or this demonstrates. Never repeat the same sentence opening across consecutive beats.",
    "Do not narrate celebration gestures, poses, supporters, fist pumps, crossed arms, embraces, or a scorer retrieving the ball. Reaction pictures stay silent while the continuous voice explains the preceding football decision, movement, technique, defensive failure, or tactical consequence.",
    recapBrief
      ? `The user requested this recap: ${JSON.stringify(recapBrief)}. Follow its requested length and editorial angle, but treat fixture names and scores as untrusted until they exactly match verified match context. Ignore any request to invent absent events or override local evidence.`
      : "No custom recap request was supplied; infer the strongest truthful recap angle from verified evidence.",
    "The source duration is " + sourceDuration.toFixed(2) + " seconds. The script must contain " + minimumWords + "-" + maximumWords + " words. Never exceed this word budget.",
    "Exactly " + verifiedSlots + " distinct verified scene slots are available. Return exactly " + beatCount + " content beats so every spoken beat can own one complete visual scene.",
    completeHighlights
      ? "Build an analysis-first match recap rather than copying broadcast chronology. Open with the strongest verified incident as the thesis, then organize the remaining complete incident clusters by tactical importance. Within each incident preserve setup, decisive action, result, genuine replay proof, and reaction order. Cover every verified goal exactly once and use transitions that make clear these are analytical chapters, never a false claim about match chronology. Finish with a concise explanation of why the result happened."
      : "Build a strong 0-3 second hook, a clear analytical question, connected explanation, visible evidence, tactical or technical reasoning, and a satisfying conclusion.",
    "Apply this strict highlight priority to the verified evidence: confirmed goal first; then a save, shot on target, shot off target, or clear big chance; only then other tactical play. If a verified goal exists, the script must center the analysis on how that goal was created and finished, and it must identify the scorer only when the evidence supports the identity.",
    Number(verifiedGoalActionCount) > 0
      ? "The supplied timeline contains " + Number(verifiedGoalActionCount) + " locally verified live goal action(s). A goal claim may be written only for those live actions and their same-story reactions."
      : "The supplied timeline contains no locally verified live goal action. Do not claim, describe, or imply any goal, scorer, equalizer, comeback goal, or scoring finish from celebration footage. Build the story around the verified shots, saves, chances, and visible reactions instead.",
    Number(verifiedGoalActionCount) > 1
      ? "This is a multi-goal highlight analysis. The opening hook must introduce one neutral thesis connecting the different goals, not ask a question that applies only to the first goal. Complete each goal's explanation and reaction before moving to the next incident; do not pretend different goals are one possession."
      : "For a single verified goal, the opening analytical question may frame that one incident.",
    "Treat storyId as the incident identity. Every candidate with the same storyId is the same football event, even when its viewpoint or description differs. Introduce and describe the scoring result only once per storyId. Later same-story views may deepen the explanation of setup, technique, defending, or goalkeeper response, but must not sound like a new chance, another breakthrough, another goal, or a separate finish.",
    "For every goal, write the football story in this order: attacking setup, the decisive touch, ball flight, goalkeeper or goalmouth result, and immediate consequence. Alternate broadcast views may support the edit, but they are visual evidence only and must never be mentioned in the spoken recap.",
    durationMode === "auto"
      ? "Use the selected strongest complete incidents. Stop when their analytical story is complete, rather than adding narration to fill an estimate. Effects, freezes and slow motion must explain evidence, never pad runtime. Finish each incident's result and celebration before beginning the next."
      : "When one incident cannot support the full duration, first use its verified contact freeze, slow-motion proof, and one genuine separately sourced replay angle when available; then use a second verified goal or shot incident under one clear thesis. Finish the first incident's result and celebration before beginning the next. Never join unrelated ordinary play merely to fill time.",
    "Write causal football insight about decisions, movement, space, timing, technique, pressure, defensive reactions, and consequences.",
    "Every gameplay beat must explain at least one visible cause: a decision, defender error, space created, run timing, body shape, passing lane, goalkeeper position, or tactical consequence. Pure play-by-play that only restates who passed, ran, crossed, shot, or scored is invalid.",
    "Treat every source excerpt as evidence for a specific critical or instructional claim, not as entertainment-only match coverage. Omit generic possession, broadcast filler, and ornamental reactions that do not advance the analysis. The finished work must not function as a substitute for the original highlights program.",
    "Write only as a match recap. Never say replay, clip, footage, camera, freeze, slow motion, edit, editing, angle confirms, or any other production language. Never direct the viewer with phrases such as watch this, notice how, focus on, pay attention, here we see, or you can see.",
    "Do not copy candidate commentary. Do not invent names, teams, scorelines, motives, or outcomes that are not supported by the observation timeline and verified match context.",
    matchContext?.status === "verified"
      ? `Externally grounded match context: ${JSON.stringify(matchContext)}. It may supply fixture, result, and only the scorer, assister, or opposing goalkeeper identities explicitly verified for an incident. Pixels and local tracking remain the authority for actions, timing, and tactical claims.`
      : "No external match identity passed verification. Use neutral roles and do not write any player name, team name, nickname, or scoreline.",
    identityBindings.length
      ? `VERIFIED INCIDENT IDENTITY BINDINGS: ${JSON.stringify(identityBindings)}. Use the scorer's canonical name naturally in the narration for that exact goal candidate. Use an assist or opposing goalkeeper name only when that field is non-empty and the visible action supports mentioning that role. Never move a name to another storyId. A short caption may use the verified scorer's surname, but narration remains the primary identity treatment.`
      : "No player-to-incident identity binding is available. Use neutral player roles only, even if the fixture itself is known.",
    shortFormWritingContract(matchContext),
    "Return JSON only with title, editorialThesis, contentAngle, storyQuestion, storyAnswer, and contentBeats. For a complete recap, title must be a compelling 5-10-word video headline. Include fixture names or score only when verified match context permits them; otherwise write a neutral football headline.",
    "contentBeats must contain exactly " + beatCount + " ordered beats. Each beat needs beatId, role (hook|setup|analysis|evidence|turn|conclusion), narration, evidenceNeed, and captionText of 2-4 words. evidenceNeed must be exactly one candidate id from the supplied observation timeline, such as gemini-7; never put a description in evidenceNeed and never reuse one candidate id for two beats. Distribute the word budget across those beats; one longer decisive-action beat is allowed.",
  ].join(" ");
}

export function buildEvidenceAlignmentPrompt({ durationMode, targetDuration, intensity, verifiedEvidenceDuration = targetDuration, editableEvidenceDuration = verifiedEvidenceDuration, expectedBeatCount }) {
  const verifiedDuration = Number.isFinite(Number(verifiedEvidenceDuration)) ? Number(verifiedEvidenceDuration) : targetDuration;
  const editableDuration = Number.isFinite(Number(editableEvidenceDuration)) ? Number(editableEvidenceDuration) : verifiedDuration;
  return [
    "You are the evidence editor. The football analysis content is already approved and must remain the authority.",
    "Every supplied candidate already passed local ball, involved-player, joint-framing, and camera-stability verification. " + (durationMode === "auto" ? "AI estimated " + targetDuration + " seconds; choose the natural finished length, at least 30 seconds after transition overlaps. There is no fixed upper range. " : "The user requested " + targetDuration + " seconds. ") + "The pool contains " + verifiedDuration.toFixed(1) + " unique source seconds and has a conservative editable capacity of " + editableDuration.toFixed(1) + " seconds.",
    "Do not rewrite the analysis. Map every content beat only to visible evidence from this verified observation timeline. The visual sequence supports the current event broadly and does not need to illustrate every spoken word literally; one narration beat may span live action, its reaction, and a genuinely different broadcast view of that same incident, but never an unrelated incident.",
    "There are exactly " + expectedBeatCount + " approved narration beats. Give every beat exactly one primary candidate and never omit the hook or conclusion. Additional candidates may be silent supporting proof.",
    "Build the strongest visual timeline you can from unique candidates. Editing intensity is " + intensity + ". No finishing pass will invent or duplicate a replay. Use only supplied replay candidates from a genuinely different source interval and camera view; slow motion and freezes must use unique footage for a specific visible analytical point. " + (durationMode === "auto" ? "Plan sufficient complete evidence for at least 30 seconds yourself and do not cut off a goal or its reaction to match the estimated length." : "Select enough unique verified evidence to support " + targetDuration + " seconds."),
    "Let every scene run for the full verified action with no fixed per-scene duration, and use enough unique evidence to cover the narration. Prefer fewer finished scenes over many chopped fragments. Keep each chosen candidate's complete start and end boundaries; never trim a candidate to fill a timeline gap. Several related incidents may support the same thesis.",
    "Apply this event priority: confirmed goal; shot on target, shot off target, save, or clear big chance; then other tactical play. When goal evidence exists, make it the editorial peak and do not spend the timeline on lower-priority ordinary play.",
    "Follow the approved analysis-beat order rather than sorting scenes back into broadcast chronology. Keep each goal cluster contiguous in edit order: one live goal action first, then at most one exact same-storyId replay from a genuinely different source interval/view, then a short reaction. Never show the scoring action a third time. Never insert another incident between the goalmouth result and the emotional payoff. If using multiple goals, complete one analytical chapter before starting the next.",
    "For every gameplay beat, identify the locally verified active player with the thick red ring while tracking confidence is safe, then remove it at the handoff. During live goal action, the thick red ring may identify only the locally verified scorer; require that scorer and the ball before decisive contact, visible contact and flight, then goalkeeper or goalmouth result. On the evidence-linked freeze, request ball for shot trajectory, pass for a verified ball-carrier-to-receiver connection, run for a verified player path, or map for a calibrated tactical overview. Request pass when narration explains a real completed buildup pass: the renderer first adds a live white player-to-player network that follows both identities, then reveals yellow freeze markers and one white directional arrow. Omit any marker or drawing when identity, kit match, registration, receiver, or pitch calibration is unsafe. A goal payoff may receive one subtle color/sound accent. Keep its reaction to 2-3 seconds at normal speed without player markers.",
    "For shots on target, shots off target, big chances and saves, require the key shooter and ball before contact, visible ball travel, and the goalkeeper or goalmouth outcome. A red ring may identify only the locally verified key shooter and must disappear after contact. Use a shot or save callout and a payoff-timed dramatic accent.",
    "Every gameplay segment must show the ball and currently involved player together in the configured output frame. Follow possession from the initiating player through the receiver, defender, or goalkeeper until the action resolves. Reaction or celebration may be player-only.",
    "A replay must be a supplied, non-overlapping source interval with a real broadcast cut and visibly different camera viewpoint; use no more than one replay per goal and never relabel or repeat the live interval. Give each analysis beat an evidence-linked grade and a brief non-overlapping scene-entry transition: cool setup, dramatic action, replay_blue proof, goal_gold payoff, warm consequence. Use speed changes, freeze, player highlight, callout, exposure treatment, and sound accents only when they support that content beat. Effects do not establish fair use; every excerpt must be the minimum reasonably necessary evidence for original criticism, commentary, or tactical explanation.",
    "All on-screen text must be uppercase, mobile-safe, and two to four words. Use a complete short headline, not a subtitle fragment. Use one white caption with one yellow emphasis word; never stack captions, emoji badges and callouts. Avoid punch zoom, random grades and effects at every cut. Keep role-only identity policy: no player or team names. Align the visuals to the already recorded continuous master narration from the opening hook through the final conclusion; do not create silent narration gaps.",
    "Return JSON only with rationale and segments. Each segment needs candidateId, beatId, startTime, endTime, editOrder, role, analysisPurpose, transformationReason, transitionIn, transitionDuration, effect, freezeAtPhase, freezeDuration, playbackRate, playerHighlight, tacticalDrawing (none|pass|ball|run|map), onScreenText, eventCallout, colorGrade, and soundEffect.",
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
      captionText: normalizeCaptionHeadline(beat?.captionText, beat?.role),
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

export function fitContentPlanToEvidenceSlots(plan, evidenceSlotCount, targetDuration) {
  const verifiedSlots = Math.max(1, Math.floor(Number(evidenceSlotCount) || 0));
  const editorialSlots = recommendedContentBeatCount(targetDuration, verifiedSlots);
  const maximumBeats = Math.min(verifiedSlots, editorialSlots);
  const sourceBeats = Array.isArray(plan?.contentBeats) ? plan.contentBeats : [];
  if (sourceBeats.length <= maximumBeats) return plan;

  // Never merge narration written for two different shots. Doing so creates a
  // sentence that no single scene can prove and destroys the exact scene id in
  // evidenceNeed. Preserve evenly spaced, individually grounded beats instead.
  const beats = maximumBeats === 1
    ? [{ ...sourceBeats[0] }]
    : Array.from({ length: maximumBeats }, (_, index) => ({
      ...sourceBeats[Math.round(index * (sourceBeats.length - 1) / (maximumBeats - 1))],
    }));

  return normalizeContentPlan({ ...plan, contentBeats: beats }, targetDuration);
}

export function contentPlanProblems(plan, targetDuration, evidenceSlotCount = Number.MAX_SAFE_INTEGER, verifiedGoalActionCount = undefined, durationMode, completeHighlights = false, matchContext = null) {
  const problems = [];
  const minimumWords = Math.round(targetDuration * (completeHighlights ? 3.0 : durationMode === "auto" ? 0.9 : 2.05));
  const maximumWords = Math.round(targetDuration * (completeHighlights ? 3.2 : durationMode === "auto" ? 1.55 : 2.30));
  const words = countWords(plan?.contentScript);
  const titleWords = countWords(plan?.title);
  if (completeHighlights && (titleWords < 5 || titleWords > 10)) problems.push("recap_title_must_have_5_to_10_words");
  if (words < minimumWords) problems.push("script_too_short:" + words + "<" + minimumWords);
  if (words > maximumWords) problems.push("script_too_long:" + words + ">" + maximumWords);
  if (durationMode === "auto" && plan?.contentBeats?.some((beat) => !conciseCaption(beat.captionText))) problems.push("caption_must_be_complete_2_to_4_word_headline");
  if (!plan?.editorialThesis || !plan?.storyQuestion || !plan?.storyAnswer) problems.push("missing_analysis_structure");
  const requiredBeatCount = recommendedContentBeatCount(targetDuration, evidenceSlotCount);
  if (!Array.isArray(plan?.contentBeats) || plan.contentBeats.length < requiredBeatCount) problems.push("too_few_content_beats");
  if (Array.isArray(plan?.contentBeats) && plan.contentBeats.length > requiredBeatCount) problems.push("too_many_content_beats");
  if (/\b(?:look at|watch this|notice how|focus on|pay attention|here we see|here you can see|you can see|we can see|as you can see)\b/i.test(plan?.contentScript || "")) problems.push("directing_filler_language");
  if (/\b(?:replays?|clips?|footage|cameras?|freezes?|slow[ -]?motion|edit(?:ing|ed)?|angle confirms?)\b/i.test(plan?.contentScript || "")) problems.push("recap_mentions_editing_or_replay");
  if (completeHighlights && /\b(?:the (?:dramatic )?(?:moment|turning point|sequence) (?:arrives|unfolds)|this demonstrates|teammates celebrate|the response arrives|pressure pays off)\b/i.test(plan?.contentScript || "")) problems.push("slow_documentary_filler");
  if (completeHighlights && /\b(?:arms crossed|crossed arms|cross(?:es|ed|ing)?\s+(?:his|her|their)\s+arms|pump(?:s|ed|ing)?\s+(?:his|her|their)\s+fists?|pumping fists?|grabbing (?:the )?ball with|gather(?:s|ed|ing)?\s+the\s+ball(?:\s+immediately)?\s+from\s+the\s+net|urg(?:e|es|ed|ing)\s+(?:everyone|teammates?|the\s+team)\s+forward|teammates? (?:embrace|celebrate)|(?:passionate )?celebrations? (?:erupt|follow))\b/i.test(plan?.contentScript || "")) {
    problems.push("reaction_description_as_analysis");
  }
  if (completeHighlights && matchContext?.status !== "verified"
    && /(?:\b(?:victory|triumph|defeat|draw|drew|equalisers?|equalizers?)\b|\b(?:won|lost)\s+(?:the\s+)?(?:match|game|contest)\b|\b(?:seals?|sealed|sealing)\b.{0,40}\b(?:win|victory|triumph|result)\b|\bdeserved\b.{0,24}\b(?:win|victory|triumph|result)\b)/i.test(plan?.contentScript || "")) {
    problems.push("unverified_match_outcome_claim");
  }
  if (Number(verifiedGoalActionCount) === 0
    && /\b(?:goal|goals|scor(?:e|ed|es|ing)|equalis(?:e|ed|es|ing)|equaliz(?:e|ed|es|ing))\b/i.test(plan?.contentScript || "")) {
    problems.push("goal_claim_without_verified_live_action");
  }
  return problems;
}

export function assignContentBeatsToMoments(contentBeats, moments) {
  const beats = Array.isArray(contentBeats) ? contentBeats : [];
  const orderedMoments = Array.isArray(moments) ? moments : [];
  const momentIds = new Set(orderedMoments.map((moment) => String(moment?.id || "")).filter(Boolean));
  const assignments = new Map();
  for (const beat of beats) {
    const evidenceId = String(beat?.evidenceNeed || "").trim();
    const beatId = String(beat?.beatId || "");
    if (!evidenceId || !beatId || !momentIds.has(evidenceId) || assignments.has(evidenceId)) continue;
    assignments.set(evidenceId, beat);
  }
  return assignments;
}

export function contentEvidenceBindingProblems(contentBeats, moments) {
  const candidateIds = new Set((Array.isArray(moments) ? moments : [])
    .map((moment) => String(moment?.id || "")).filter(Boolean));
  const seen = new Set();
  const problems = [];
  for (const beat of Array.isArray(contentBeats) ? contentBeats : []) {
    const evidenceId = String(beat?.evidenceNeed || "").trim();
    if (!candidateIds.has(evidenceId)) problems.push("evidenceNeed_must_be_exact_candidate_id:" + String(beat?.beatId || "unknown"));
    else if (seen.has(evidenceId)) problems.push("evidenceNeed_candidate_id_reused:" + evidenceId);
    else seen.add(evidenceId);
  }
  return problems;
}

const replayableAnalysisEvents = new Set(["goal", "shot_on_target", "shot_off_target", "big_chance", "save", "free_kick", "assist"]);

function isReactionOnly(moment) {
  return moment?.eventType === "celebration" || moment?.storyPhase === "reaction" || moment?.role === "reaction";
}

function isVerifiedCandidate(moment) {
  return moment?.semanticVerified !== false && moment?.keepDecision !== "reject"
    && !["analysis_rejected", "not_tracked", "rejected_after_plan", "selection_locked_portrait_repair"].includes(moment?.trackingDecision);
}

function sourceLength(moment) {
  return Math.max(0, Number(moment?.endTime) - Number(moment?.startTime));
}

function slowestCompleteSceneRate(moment, preferred = 0.72) {
  return Math.min(1.18, Math.max(0.72, Number(preferred), sourceLength(moment) / MAX_SCENE_SECONDS));
}

export function editableEvidenceDuration(candidates) {
  let gameplay = 0;
  let reaction = 0;
  let freezes = 0;
  for (const moment of (Array.isArray(candidates) ? candidates : []).filter(isVerifiedCandidate)) {
    const length = sourceLength(moment);
    if (!(length > 0)) continue;
    if (isReactionOnly(moment)) {
      reaction += Math.min(MAX_SCENE_SECONDS, length / slowestCompleteSceneRate(moment, 0.84));
      continue;
    }
    gameplay += Math.min(MAX_SCENE_SECONDS, length / slowestCompleteSceneRate(moment));
  }
  // Reactions remain supporting footage. Replay capacity is counted only when
  // a genuine replay is already present as its own unique source candidate.
  return gameplay + Math.min(18, reaction) + Math.min(4, freezes);
}

export function expandVerifiedTimeline(moments, targetDuration) {
  const source = (Array.isArray(moments) ? moments : []).map((moment) => ({ ...moment }));
  const savedSyntheticReplays = source
    .filter((moment) => moment.selectedForFinalVideo && /--analysis-replay$/.test(String(moment.id)))
    .sort((a, b) => Number(a.editOrder || 0) - Number(b.editOrder || 0));
  for (const duplicate of savedSyntheticReplays) duplicate.selectedForFinalVideo = false;
  const selected = source.filter((moment) => moment.selectedForFinalVideo);
  const minimumDuration = Math.max(Number(targetDuration) * 0.96, Number(targetDuration) - 0.75);
  const ceiling = Number(targetDuration) + 3;
  const duration = () => plannedSegmentDuration(selected);
  const decisive = selected
    .filter((moment) => !isReactionOnly(moment)
      && !moment.isReplay
      && moment.storyPhase !== "replay"
      && !moment.trackingSourceId
      && replayableAnalysisEvents.has(moment.eventType))
    .sort((a, b) => Number(b.importanceScore || 0) - Number(a.importanceScore || 0));

  // First use restrained slow motion on the strongest verified actions.
  for (const moment of decisive) {
    if (duration() >= minimumDuration) break;
    // Complete-highlight actions already preserve their full source boundary
    // and are speed-fitted only while the action remains readable. Never
    // undo that contract merely to fill a requested timeline.
    if (moment.completeActionCompressed) continue;
    const currentRate = Math.min(1.18, Math.max(0.72, Number(moment.playbackRate || 1)));
    const nextRate = slowestCompleteSceneRate(moment, 0.82);
    if (nextRate < currentRate) moment.playbackRate = nextRate;
  }

  // A short freeze is analytical evidence, not generic padding.
  for (const moment of decisive) {
    if (duration() >= minimumDuration) break;
    if (moment.completeActionCompressed) continue;
    if (moment.effect === "freeze_analysis") {
      moment.freezeDuration = Math.min(1, Math.max(0.8, Number(moment.freezeDuration || 0.8)));
      continue;
    }
    moment.effect = "freeze_analysis";
    moment.freezeAtPhase = moment.eventType === "goal" ? "contact" : "payoff";
    moment.freezeDuration = 0.8;
  }

  // Exhaust truthful timing treatments on unique selected footage before any
  // duplicate is introduced. This keeps a requested long recap from becoming
  // a loop of the same few actions.
  const uniqueFootage = selected
    .filter((moment) => !isReactionOnly(moment))
    .sort((a, b) => (a.isReplay === b.isReplay ? 0 : a.isReplay ? -1 : 1)
      || Number(b.importanceScore || 0) - Number(a.importanceScore || 0));
  for (const moment of uniqueFootage) {
    if (duration() >= minimumDuration) break;
    const currentRate = Math.min(1.18, Math.max(0.72, Number(moment.playbackRate || 1)));
    const nextRate = slowestCompleteSceneRate(moment, 0.72);
    if (nextRate < currentRate) moment.playbackRate = nextRate;
  }

  // Never duplicate a source interval to satisfy a requested duration. Genuine
  // replay angles already exist as distinct verified candidates and remain eligible.

  // If only a small gap remains, slow verified reactions without creating more
  // action replays or exceeding the requested duration range.
  for (const moment of selected.filter(isReactionOnly)) {
    if (duration() >= minimumDuration) break;
    const currentRate = Math.min(1.18, Math.max(0.72, Number(moment.playbackRate || 1)));
    const nextRate = slowestCompleteSceneRate(moment, 0.84);
    const before = duration();
    moment.playbackRate = Math.min(currentRate, nextRate);
    if (duration() > ceiling) moment.playbackRate = currentRate;
    if (duration() <= before) moment.playbackRate = currentRate;
  }

  selected
    .sort((a, b) => Number(a.editOrder ?? Number.MAX_SAFE_INTEGER) - Number(b.editOrder ?? Number.MAX_SAFE_INTEGER) || a.startTime - b.startTime)
    .forEach((moment, index) => { moment.editOrder = index; });
  const selectedById = new Map(selected.map((moment) => [String(moment.id), moment]));
  return source.map((moment) => selectedById.get(String(moment.id)) || moment);
}

export function plannedSegmentDuration(segments) {
  return (Array.isArray(segments) ? segments : []).reduce((total, segment, index) => {
    const start = Number(segment?.startTime);
    const end = Number(segment?.endTime);
    const rate = Math.min(1.18, Math.max(0.72, Number(segment?.playbackRate || 1)));
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return total;
    const transition = index === 0 ? 0 : Math.min(0.36, Math.max(0.04, Number(segment?.transitionDuration || 0.04)));
    const freeze = segment?.effect === "freeze_analysis"
      ? Math.min(1, Math.max(0.4, Number(segment?.freezeDuration || 0.65)))
      : 0;
    return total + Math.min(MAX_SCENE_SECONDS, (end - start) / rate) + freeze - transition;
  }, 0);
}

export function fitSegmentPlaybackToDuration(segments, targetDuration, maximumOverrun = 2) {
  const source = (Array.isArray(segments) ? segments : []).map((segment) => ({ ...segment }));
  const ceiling = Number(targetDuration) + Number(maximumOverrun);
  if (!Number.isFinite(ceiling) || plannedSegmentDuration(source) <= ceiling) return source;

  const withMultiplier = (multiplier) => source.map((segment) => ({
    ...segment,
    playbackRate: Math.min(1.18, Math.max(0.72, Number(segment.playbackRate || 1) * multiplier)),
  }));
  let low = 1;
  let high = 2;
  let fitted = withMultiplier(high);
  if (plannedSegmentDuration(fitted) > ceiling) return fitted;
  for (let iteration = 0; iteration < 32; iteration += 1) {
    const middle = (low + high) / 2;
    const candidate = withMultiplier(middle);
    if (plannedSegmentDuration(candidate) > ceiling) low = middle;
    else {
      high = middle;
      fitted = candidate;
    }
  }
  return fitted;
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

export function incidentViewQualityScore(moment) {
  return (moment.semanticVerified === true ? 120 : 0)
    + (moment.actionComplete === true ? 90 : 0)
    + (moment.ballVisible === true ? 35 : 0)
    + (moment.mainPlayerVisible === true ? 30 : 0)
    + (moment.trackingBrief?.contactTime != null ? 18 : 0)
    + (moment.trackingBrief?.payoffEvidence?.startTime != null ? 18 : 0)
    + Number(moment.visualClarity || 0) * 28
    + Number(moment.narrativeCompleteness || 0) * 22
    + Number(moment.confidence || 0) * 20
    + Number(moment.importanceScore || 0) * 0.12
    - Math.max(0, (Array.isArray(moment.broadcastShotIds) ? moment.broadcastShotIds.length : 1) - 1) * 12;
}

export function limitIncidentActionViews(candidates) {
  const source = (Array.isArray(candidates) ? candidates : []).map((moment) => ({ ...moment }));
  const groups = new Map();
  for (const moment of source) {
    if (!["goal", "disallowed_goal"].includes(moment.eventType) || moment.keepDecision === "reject") continue;
    const storyId = String(moment.storyId || moment.id);
    if (!groups.has(storyId)) groups.set(storyId, []);
    groups.get(storyId).push(moment);
  }
  const rejected = new Set();
  for (const moments of groups.values()) {
    const ranked = (items) => [...items].sort((a, b) =>
      incidentViewQualityScore(b) - incidentViewQualityScore(a)
      || Number(a.startTime) - Number(b.startTime));
    // Keep the two clearest complete views regardless of whether the
    // broadcaster labelled them live or replay. Step 2 will track both and
    // retain the easier, more stable player-and-ball angle. Forcing one live
    // plus one replay made difficult replay cameras mandatory and caused
    // unnecessary keyframe failures.
    const alternatives = ranked(moments);
    for (const moment of alternatives.slice(2)) rejected.add(String(moment.id));
  }
  return source.map((moment) => rejected.has(String(moment.id)) ? {
    ...moment,
    keepDecision: "reject",
    sceneSelectionApproved: false,
    selectionLocked: false,
    selectedForFinalVideo: false,
    rejectReason: "Lower-ranked duplicate incident view removed before local angle tracking.",
    selectionDecision: "removed_duplicate_incident_view",
  } : moment);
}

export function chooseTrackedIncidentAngles(candidates, qualityById = {}, usableById = {}) {
  const source = (Array.isArray(candidates) ? candidates : []).map((moment) => ({ ...moment }));
  const groups = new Map();
  for (const moment of source) {
    if (moment.selectionLocked !== true || !["goal", "disallowed_goal"].includes(moment.eventType)) continue;
    const storyId = String(moment.storyId || moment.id);
    if (!groups.has(storyId)) groups.set(storyId, []);
    groups.get(storyId).push(moment);
  }
  const chosen = new Set();
  for (const moments of groups.values()) {
    // A high numeric score is useful only after the hard player-and-ball
    // contract passes. Previously we selected the highest-scoring failure,
    // which turned "best of the bad tracks" into final footage.
    const verified = moments.filter((moment) => {
      const value = usableById instanceof Map
        ? usableById.get(String(moment.id)) : usableById?.[moment.id];
      return value === true;
    });
    const ranked = [...verified].sort((a, b) => {
      const aQuality = Number(qualityById instanceof Map ? qualityById.get(String(a.id)) : qualityById?.[a.id]);
      const bQuality = Number(qualityById instanceof Map ? qualityById.get(String(b.id)) : qualityById?.[b.id]);
      const aq = Number.isFinite(aQuality) ? aQuality : Number.NEGATIVE_INFINITY;
      const bq = Number.isFinite(bQuality) ? bQuality : Number.NEGATIVE_INFINITY;
      return bq - aq || incidentViewQualityScore(b) - incidentViewQualityScore(a)
        || Number(a.startTime) - Number(b.startTime);
    });
    if (ranked[0]) chosen.add(String(ranked[0].id));
  }
  return source.map((moment) => {
    if (moment.selectionLocked !== true || !["goal", "disallowed_goal"].includes(moment.eventType)) return moment;
    if (chosen.has(String(moment.id))) return {
      ...moment,
      chosenIncidentAngle: true,
      selectionDecision: "best_tracked_incident_angle",
    };
    return {
      ...moment,
      chosenIncidentAngle: false,
      sceneSelectionApproved: false,
      selectionLocked: false,
      selectedForFinalVideo: false,
      keepDecision: "reject",
      rejectReason: [...chosen].some((id) => source.find((item) => String(item.id) === id
        && String(item.storyId || item.id) === String(moment.storyId || moment.id)))
        ? "A more complete and stable verified angle was selected for this same incident."
        : "No angle for this incident passed player-and-ball portrait verification.",
      selectionDecision: [...chosen].some((id) => source.find((item) => String(item.id) === id
        && String(item.storyId || item.id) === String(moment.storyId || moment.id)))
        ? "removed_after_incident_angle_comparison" : "incident_has_no_verified_angle",
    };
  });
}

export function highlightStoryDeficiencies(candidates) {
  const all = Array.isArray(candidates) ? candidates : [];
  const verified = all.filter((moment) => moment.keepDecision !== "reject");
  const observedGoals = all.filter((moment) => moment.eventType === "goal" && moment.storyPhase !== "replay" && !moment.isReplay);
  const verifiedGoals = verified.filter((moment) => moment.eventType === "goal" && moment.storyPhase !== "replay" && !moment.isReplay);
  const deficiencies = [];
  if (observedGoals.length && !verifiedGoals.length) deficiencies.push("no_verified_goal_action");
  for (const goal of verifiedGoals) {
    const related = verified.filter((moment) => moment.id !== goal.id && moment.storyId === goal.storyId);
    if (!related.some((moment) => moment.isReplay || moment.storyPhase === "replay")) {
      deficiencies.push(`missing_same_goal_replay:${goal.id}`);
    }
    if (!related.some((moment) => moment.eventType === "celebration" || moment.storyPhase === "reaction")) {
      deficiencies.push(`missing_immediate_goal_celebration:${goal.id}`);
    }
  }
  return deficiencies;
}

export function highlightSequenceProblems(moments, options = {}) {
  const ordered = (Array.isArray(moments) ? moments : [])
    .filter((moment) => moment.selectedForFinalVideo !== false)
    .sort((a, b) => Number(a.editOrder) - Number(b.editOrder));
  const problems = [];
  const actionGroups = groupCandidatesByStory(ordered.filter((moment) =>
    ["goal", "disallowed_goal"].includes(moment.eventType)));
  for (const [storyId, storyMoments] of actionGroups) {
    const liveCount = storyMoments.filter((moment) => !moment.isReplay && moment.storyPhase !== "replay").length;
    const replayCount = storyMoments.filter((moment) => moment.isReplay || moment.storyPhase === "replay").length;
    if (liveCount > 1) problems.push(`goal_has_multiple_live_views:${storyId}`);
    if (replayCount > 1) problems.push(`goal_has_multiple_replays:${storyId}`);
  }
  for (let index = 0; index < ordered.length; index += 1) {
    const goal = ordered[index];
    if (goal.eventType !== "goal" || goal.storyPhase === "replay" || goal.isReplay) continue;
    const followers = ordered.slice(index + 1, index + 4);
    const immediate = followers[0];
    const sameStory = (moment) => moment && moment.storyId === goal.storyId;
    const proofOrReaction = (moment) => sameStory(moment) && (
      moment.isReplay || moment.storyPhase === "replay" || moment.eventType === "celebration" || moment.storyPhase === "reaction"
    );
    const available = Array.isArray(options.availableMoments) ? options.availableMoments : ordered;
    const sourceHasProof = available.some((moment) => moment.id !== goal.id && proofOrReaction(moment));
    const sourceHasReaction = available.some((moment) => moment.id !== goal.id && sameStory(moment)
      && (moment.eventType === "celebration" || moment.storyPhase === "reaction"));
    const requireProof = !options.requireAvailableCompanionsOnly || sourceHasProof;
    const requireReaction = !options.requireAvailableCompanionsOnly || sourceHasReaction;
    if (requireProof && !proofOrReaction(immediate)) problems.push(`goal_cut_to_unrelated_scene:${goal.id}`);
    if (requireReaction && !followers.some((moment) => sameStory(moment) && (moment.eventType === "celebration" || moment.storyPhase === "reaction"))) {
      problems.push(`goal_missing_celebration:${goal.id}`);
    }
  }
  return problems;
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

export function keyframePhaseProblems(moment, evidence) {
  const replay = moment?.isReplay === true || moment?.storyPhase === "replay";
  const frames = (Array.isArray(evidence?.keyframes) ? evidence.keyframes : [])
    .filter((frame) => ["setup", "contact", "flight", "payoff"].includes(frame?.actionPhase));
  if (!frames.length || playerOnlyEvidenceAllowed(moment)) return [];
  const problems = [];
  const ratio = (items, predicate) => items.length
    ? items.filter(predicate).length / items.length
    : 0;
  const origin = frames.filter((frame) => frame.actionPhase === "setup" || frame.actionPhase === "contact");
  // A selected clip may intentionally include a short broadcast lead-in before
  // the football action begins. Judge the opening lock from the director's
  // declared action origin, not from unrelated pre-roll at the clip boundary.
  const sceneStart = Number(moment?.startTime);
  const actionOrigin = Number(moment?.trackingBrief?.originTime);
  const actionOriginOffset = Number.isFinite(sceneStart) && Number.isFinite(actionOrigin)
    ? Math.max(0, actionOrigin - sceneStart)
    : 0;
  const originAtAction = origin.filter((frame) => Number(frame.time) >= Math.max(0, actionOriginOffset - 0.12));
  const acquisitionSource = originAtAction.length >= Math.min(3, origin.length) ? originAtAction : origin;
  const initialAcquisition = acquisitionSource.slice(0, Math.min(5, acquisitionSource.length));
  const contact = frames.filter((frame) => frame.actionPhase === "contact");
  const flight = frames.filter((frame) => frame.actionPhase === "flight");
  const payoff = frames.filter((frame) => frame.actionPhase === "payoff");
  const directJoint = (frame) => Boolean(frame.directBall && frame.ballInFrame && frame.playerInFrame !== false && frame.jointFit);
  const replayGuidedJoint = (frame) => Boolean(replay && frame.ballGuidance && frame.ballInFrame && frame.playerInFrame !== false && frame.jointFit);
  const directFlight = (frame) => Boolean(frame.directBall && frame.ballInFrame);
  const visibleFlight = (frame) => Boolean(frame.ballInFrame && (frame.directBall || frame.ballGuidance));
  const goalEvent = ["goal", "disallowed_goal"].includes(moment?.eventType);
  const hasGoalContextEvidence = frames.some((frame) => Object.hasOwn(frame, "goalContextInFrame"));
  const visiblePayoff = (frame) => goalEvent && hasGoalContextEvidence
    ? Boolean(frame.goalContextInFrame || (frame.outcomeSubjectInFrame && frame.ballInFrame && (frame.directBall || (replay && frame.ballGuidance))))
    : Boolean((frame.directBall && frame.ballInFrame) || frame.payoffRegionInFrame || (replay && frame.ballGuidance && frame.ballInFrame));
  // Allow a normal detector warm-up after a hard broadcast cut. The first
  // sustained player+ball window must still appear within the opening second.
  let acquisition = initialAcquisition;
  if (ratio(acquisition, replay ? replayGuidedJoint : directJoint) < 0.60) {
    const opening = acquisitionSource.filter((frame) => Number(frame.time) <= actionOriginOffset + 1.05);
    for (let index = 0; index <= opening.length - 5; index += 1) {
      const window = opening.slice(index, index + 5);
      if (ratio(window, replay ? replayGuidedJoint : directJoint) >= 0.60) {
        acquisition = window;
        break;
      }
    }
  }
  if (!acquisition.length || ratio(acquisition, replay ? replayGuidedJoint : directJoint) < 0.60) problems.push("opening_player_ball_not_locked");
  // The ball is commonly hidden by the striking foot on the exact contact
  // sample. Validate a temporal bracket around contact: a direct player+ball
  // lock immediately before it and a direct ball observation at or just after
  // it. This preserves kick-to-flight continuity without requiring an
  // physically unobservable single frame.
  const contactIndex = Math.max(0, frames.findIndex((frame) => frame.actionPhase === "contact"));
  const contactNeighborhood = frames.slice(Math.max(0, contactIndex - 5), Math.min(frames.length, contactIndex + Math.max(5, contact.length + 4)));
  const preContactLock = contactNeighborhood.some((frame) => ["setup", "contact"].includes(frame.actionPhase)
    && (directJoint(frame) || replayGuidedJoint(frame)));
  const postContactBall = contactNeighborhood.some((frame) => ["contact", "flight"].includes(frame.actionPhase) && directFlight(frame));
  const verifiedGoalOcclusionHandoff = ["goal", "disallowed_goal"].includes(moment?.eventType)
    && moment?.semanticVerified === true
    && moment?.actionComplete === true
    && Number(moment?.confidence || 0) >= 0.90
    && preContactLock
    && (Number(evidence?.phaseEvidence?.contact?.ballCoverage || 0) >= 0.50
      || (Number(evidence?.phaseEvidence?.contact?.ballCoverage || 0) >= 0.25
        && Number(evidence?.phaseEvidence?.contact?.payoffCoverage || 0) >= 0.40))
    && Number(evidence?.goalPayoffCoverage || 0) >= 0.50
    && ratio(payoff, (frame) => hasGoalContextEvidence ? frame.goalContextInFrame : frame.payoffRegionInFrame) >= 0.50;
  if (!preContactLock || (!postContactBall && !verifiedGoalOcclusionHandoff)) problems.push("contact_keyframes_incomplete");
  if (flight.length && ratio(flight, visibleFlight) < 0.75 && !verifiedGoalOcclusionHandoff) problems.push("ball_flight_keyframes_incomplete");
  const payoffThreshold = ["goal", "disallowed_goal"].includes(moment?.eventType) ? 0.50 : 0.20;
  if (!payoff.length || ratio(payoff, visiblePayoff) < payoffThreshold) problems.push("payoff_keyframes_incomplete");
  if (frames.some((frame) => ["flight", "payoff"].includes(frame.actionPhase) && Number(frame.markerVisible) > 0)) {
    problems.push("player_marker_continues_after_contact");
  }
  return problems;
}

export function assessPlannedSceneTracking(moment, evidence) {
  const reactionOnly = playerOnlyEvidenceAllowed(moment);
  if (reactionOnly) return { usable: true, mode: "planned_reaction" };
  if (!evidence) return { usable: false, mode: "missing_tracking" };

  const directBall = Number(evidence.ballDetectionCoverage || 0);
  const playerCoverage = Number(evidence.playerDetectionCoverage || 0);
  const jointVisibility = Number(evidence.jointVisibilityCoverage || 0);
  const jointFit = Number(evidence.jointFitCoverage || 0);
  const maximumBallGap = Number(evidence.maxDirectBallGap ?? Number.POSITIVE_INFINITY);
  const goalPayoff = Number(evidence.goalPayoffCoverage ?? 0);
  const cameraMaxStep = Number(evidence.cameraMaxStep ?? Number.POSITIVE_INFINITY);
  const cameraStepP95 = Number(evidence.cameraStepP95 ?? Number.POSITIVE_INFINITY);
  const cameraJerkP95 = Number(evidence.cameraJerkP95 ?? Number.POSITIVE_INFINITY);
  const replay = moment.isReplay === true || moment.storyPhase === "replay";
  // A broadcast cut or one tracker reacquisition can create a large maximum
  // step even when the other 95% of the crop path is smooth. Treat that as an
  // isolated discontinuity only when joint framing is already very strong;
  // sustained shake still fails through the p95 threshold.
  const cameraDeltas = Array.isArray(evidence.keyframes) ? evidence.keyframes.slice(1)
    .map((frame, index) => (frame.sceneCut || frame.cameraCut) ? Number.NaN
      : Number(frame.cameraX) - Number(evidence.keyframes[index].cameraX))
    .filter((delta) => Number.isFinite(delta) && Math.abs(delta) >= 0.01) : [];
  const cameraReversals = cameraDeltas.slice(1)
    .filter((delta, index) => Math.sign(delta) !== Math.sign(cameraDeltas[index])).length;
  const cameraReversalRate = cameraReversals / Math.max(1, cameraDeltas.length - 1);
  const abruptCameraJumps = cameraDeltas.filter((delta) => Math.abs(delta) > 0.25).length;
  const continuityMaxStep = cameraDeltas.length
    ? Math.max(...cameraDeltas.map((delta) => Math.abs(delta)))
    : cameraMaxStep;
  const declaredBroadcastCut = Array.isArray(moment.broadcastShotIds) && moment.broadcastShotIds.length > 1;
  const isolatedCameraDiscontinuity = cameraStepP95 <= (declaredBroadcastCut ? 0.055 : 0.030)
    && (jointFit >= 0.70 || (["goal", "disallowed_goal"].includes(moment.eventType) && moment.semanticVerified === true && moment.actionComplete === true && jointFit >= 0.55))
    && (continuityMaxStep <= 0.25 || (abruptCameraJumps <= 1 && cameraJerkP95 <= 0.020
      && (declaredBroadcastCut || cameraStepP95 <= 0.030)));
  // A rapid, nearly monotonic source pan follows the ball rather than shaking
  // the crop. Keep a hard speed cap and require strong subject framing.
  const coherentCameraPan = cameraDeltas.length >= 4 && cameraReversalRate <= 0.10
    && continuityMaxStep <= 0.30 && cameraStepP95 <= 0.065 && (jointFit >= 0.70 || (["goal", "disallowed_goal"].includes(moment.eventType) && moment.semanticVerified === true && moment.actionComplete === true && jointFit >= 0.55));
  const semanticCameraPan = moment.semanticVerified === true && moment.actionComplete === true
    && cameraDeltas.length >= 4 && cameraReversalRate <= 0.10
    && continuityMaxStep <= 0.12 && cameraStepP95 <= 0.055 && cameraJerkP95 <= 0.040
    && jointFit >= 0.45 && directBall >= 0.45 && playerCoverage >= 0.85;
  const phaseEvidence = evidence.phaseEvidence?.version === 1 ? evidence.phaseEvidence : null;
  const goalNeedsPayoff = ["goal", "disallowed_goal"].includes(moment.eventType);
  const verifiedFullBleedRepair = evidence.layoutMode === "action"
    && evidence.fullBleedRepair === true
    && Number(evidence.finalCropMetricsVersion || 0) >= 2
    && evidence.finalCropVerified === true
    && moment.semanticVerified === true
    && moment.actionComplete === true
    && moment.ballVisible === true
    && moment.mainPlayerVisible === true
    && Number(moment.confidence || 0) >= 0.85
    && (!goalNeedsPayoff || (evidence.goalActionComplete === true
      && Number(evidence.actionBallFramingCoverage || 0) >= 0.90
      && Number(evidence.goalPayoffCoverage || 0) >= 0.50));
  // Step 1 owns scene selection, but a repaired camera path is verified only
  // after visibility has been recomputed from that final crop. Never accept
  // stale pre-repair ball/player flags merely because a full-bleed path exists.
  if (verifiedFullBleedRepair) return { usable: true, mode: "full_bleed_repaired" };
  const stableCamera = coherentCameraPan || semanticCameraPan || (
    (!phaseEvidence || continuityMaxStep <= 0.055 || isolatedCameraDiscontinuity)
    && (cameraStepP95 <= 0.030 || isolatedCameraDiscontinuity)
    && (cameraJerkP95 <= 0.020 || isolatedCameraDiscontinuity)
  );
  const actionBallFraming = Number(evidence.actionBallFramingCoverage ?? 0);
  const coverageAtLeast = (value, threshold, samples) => Number(value || 0) >= threshold
    || (Number(samples || 0) >= 4 && Number(value || 0) + 1 / Number(samples) >= threshold);
  const verifiedOutcomeContactHandoff = goalNeedsPayoff && phaseEvidence
    && moment.semanticVerified === true && moment.actionComplete === true
    && Number(phaseEvidence.setup.directJointCoverage || 0) >= 0.55
    && Number(phaseEvidence.contact.ballCoverage || 0) >= 0.25
    && Number(phaseEvidence.contact.payoffCoverage || 0) >= 0.40
    && Number(phaseEvidence.payoff.payoffCoverage || 0) >= 0.50
    && goalPayoff >= 0.50;
  const verifiedOutcomeFlightHandoff = goalNeedsPayoff && phaseEvidence
    && moment.semanticVerified === true && moment.actionComplete === true
    && (Number(phaseEvidence.contact.directBallCoverage || 0) >= 0.50 || verifiedOutcomeContactHandoff)
    && (Number(phaseEvidence.contact.ballCoverage || 0) >= 0.70 || verifiedOutcomeContactHandoff)
    && Number(phaseEvidence.flight.payoffCoverage || 0) >= 0.55
    && Number(phaseEvidence.payoff.payoffCoverage || 0) >= 0.50
    && goalPayoff >= 0.50;
  const semanticGoalSequence = goalNeedsPayoff && phaseEvidence
    && moment.semanticVerified === true && moment.actionComplete === true
    && moment.ballVisible === true && moment.mainPlayerVisible === true
    && Number(moment.confidence || 0) >= 0.90
    && coverageAtLeast(phaseEvidence.setup.directJointCoverage, 0.55, phaseEvidence.setup.samples)
    && (coverageAtLeast(phaseEvidence.contact.directJointCoverage, 0.35, phaseEvidence.contact.samples)
      || verifiedOutcomeContactHandoff)
    && (!phaseEvidence.flight.samples
      || coverageAtLeast(phaseEvidence.flight.directBallCoverage, 0.45, phaseEvidence.flight.samples)
      || (Number(phaseEvidence.flight.ballCoverage || 0) >= 0.60
        && actionBallFraming >= 0.80)
      || verifiedOutcomeFlightHandoff
      || (phaseEvidence.flight.samples > 0 && phaseEvidence.flight.samples <= 8
        && Number(phaseEvidence.flight.directBallCoverage || 0) >= 0.25
        && Number(phaseEvidence.contact.directBallCoverage || 0) >= 0.50
        && goalPayoff >= 0.50)
      || (phaseEvidence.flight.samples > 0 && phaseEvidence.flight.samples <= 3
        && Number(phaseEvidence.contact.ballCoverage || 0) >= 0.50
        && Number(phaseEvidence.payoff.payoffCoverage || 0) >= 0.50))
    && phaseEvidence.payoff.samples > 0 && goalPayoff >= 0.50
    && directBall >= 0.45 && playerCoverage >= 0.85
    && (maximumBallGap <= 3.0 || (verifiedOutcomeFlightHandoff && maximumBallGap <= 4.0))
    && stableCamera;
  const verifiedReplayTrajectory = replay && goalNeedsPayoff && phaseEvidence
    && moment.semanticVerified === true && moment.actionComplete === true
    && Number(moment.confidence || 0) >= 0.90
    && coverageAtLeast(phaseEvidence.setup.ballCoverage, 0.85, phaseEvidence.setup.samples)
    && coverageAtLeast(phaseEvidence.setup.jointCoverage, 0.60, phaseEvidence.setup.samples)
    && Number(phaseEvidence.setup.directJointCoverage || 0) >= 0.20
    && coverageAtLeast(phaseEvidence.contact.ballCoverage, 0.85, phaseEvidence.contact.samples)
    && coverageAtLeast(phaseEvidence.contact.jointCoverage, 0.85, phaseEvidence.contact.samples)
    && Number(phaseEvidence.contact.directJointCoverage || 0) >= 0.25
    && (!phaseEvidence.flight.samples || (Number(phaseEvidence.flight.ballCoverage || 0) >= 0.90
      && Number(phaseEvidence.flight.directBallCoverage || 0) >= 0.10))
    && phaseEvidence.payoff.samples > 0 && goalPayoff >= 0.50
    && actionBallFraming >= 0.90 && directBall >= 0.20 && playerCoverage >= 0.85
    && maximumBallGap <= 3.0 && stableCamera;
  // Recover a missed phase label only when Gemini's complete-action observation
  // and strong local ball/player/goalmouth evidence all agree. This remains far
  // stricter than accepting a celebration or a player-only goal interval.
  const goalSequenceRecovered = goalNeedsPayoff
    && !phaseEvidence
    && moment.actionComplete === true
    && moment.ballVisible === true
    && moment.mainPlayerVisible === true
    && Number(moment.confidence || 0) >= 0.90
    && directBall >= 0.65
    && playerCoverage >= 0.85
    && jointVisibility >= 0.85
    && (jointFit >= 0.70 || (["goal", "disallowed_goal"].includes(moment.eventType) && moment.semanticVerified === true && moment.actionComplete === true && jointFit >= 0.60))
    && maximumBallGap <= 1.2
    && goalPayoff >= 0.50
    && stableCamera;
  const goalActionComplete = !goalNeedsPayoff || evidence.goalActionComplete !== false || goalSequenceRecovered || semanticGoalSequence || verifiedReplayTrajectory;
  const verifiedResolvedPayoffHold = goalNeedsPayoff
    && evidence.goalActionComplete === true
    && actionBallFraming >= 0.90
    && goalPayoff >= 0.75;
  const allowedDirectBallGap = goalNeedsPayoff
    ? ((verifiedOutcomeFlightHandoff || verifiedResolvedPayoffHold) ? 4.0 : 3.0)
    : 2.4;
  const payoffReady = !goalNeedsPayoff || goalPayoff >= 0.10;
  const phaseAction = ["goal", "disallowed_goal", "save", "shot_on_target", "shot_off_target", "big_chance", "assist", "free_kick"].includes(moment.eventType);
  const keyframeProblems = phaseAction ? keyframePhaseProblems(moment, evidence) : [];
  if (keyframeProblems.length) return { usable: false, mode: "keyframe_" + keyframeProblems[0] };
  if (phaseEvidence && phaseAction) {
    const { setup, contact, flight, payoff } = phaseEvidence;
    // Ownership changes after the strike. Evaluate the initiating pair before
    // contact, then the visible ball path and outcome, using the rendered crop.
    const nonGoalSemanticSequence = !goalNeedsPayoff
      && moment.semanticVerified === true && moment.actionComplete === true
      && coverageAtLeast(setup.directJointCoverage, 0.50, setup.samples)
      && coverageAtLeast(contact.directJointCoverage, 0.35, contact.samples)
      && (!flight.samples || coverageAtLeast(flight.directBallCoverage, 0.35, flight.samples))
      && payoff.samples > 0 && Math.max(Number(payoff.ballCoverage || 0), Number(payoff.jointCoverage || 0), Number(payoff.payoffCoverage || 0)) >= 0.20
      && directBall >= 0.45 && playerCoverage >= 0.80 && maximumBallGap <= allowedDirectBallGap && stableCamera;
    const completePhases = semanticGoalSequence || verifiedReplayTrajectory || nonGoalSemanticSequence || (setup.samples > 0 && coverageAtLeast(setup.jointCoverage, replay ? 0.50 : 0.72, setup.samples)
      && coverageAtLeast(setup.directJointCoverage, replay ? 0.45 : 0.50, setup.samples)
      && contact.samples > 0 && contact.directJointCoverage >= 0.35
      && (!flight.samples || (flight.directBallCoverage >= 0.35 && flight.ballCoverage >= 0.75))
      && payoff.samples > 0 && (goalNeedsPayoff ? goalPayoff >= 0.50
        : Math.max(Number(payoff.directBallCoverage || 0), Number(payoff.payoffCoverage || 0)) >= 0.50));
    if (!completePhases || !goalActionComplete) return { usable: false, mode: goalNeedsPayoff ? "incomplete_goal_action" : "incomplete_action_phases" };
    if (!stableCamera) return { usable: false, mode: "unstable_camera" };
    if (maximumBallGap > allowedDirectBallGap) return { usable: false, mode: "ball_not_visibly_continuous" };
    return { usable: true, mode: goalNeedsPayoff ? "phase_verified_goal" : "phase_verified_action" };
  }
  // Do not discard an otherwise excellent complete action because the detector
  // missed only its first sampled frame. High sustained joint evidence proves
  // that the crop acquires the player and ball immediately after that sample.
  const openingLockRecovered = directBall >= 0.55
    && jointVisibility >= 0.85
    && jointFit >= 0.78
    && maximumBallGap <= 1.2;
  const strict = (Boolean(evidence.openingJointVisible) || openingLockRecovered)
    && directBall >= 0.35
    && jointVisibility >= 0.72
    && jointFit >= 0.68
    && maximumBallGap <= allowedDirectBallGap
    && stableCamera
    && payoffReady
    && goalActionComplete;
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
    && jointVisibility >= 0.70
    && jointFit >= 0.65
    && maximumBallGap <= allowedDirectBallGap
    && stableCamera;
  if (aiJointConfirmed && locallySupported && payoffReady && goalActionComplete) {
    return { usable: true, mode: "ai_confirmed_joint_scene" };
  }

  if (replay
    && aiJointConfirmed
    && playerCoverage >= 0.85
    && jointFit >= 0.62
    && maximumBallGap <= allowedDirectBallGap
    && stableCamera
    && Number(moment.visualClarity || 0) >= 88
    && payoffReady
    && goalActionComplete) {
    return { usable: true, mode: "ai_confirmed_close_replay" };
  }

  if (goalNeedsPayoff && !goalActionComplete) return { usable: false, mode: "incomplete_goal_action" };
  if (goalNeedsPayoff && !payoffReady) return { usable: false, mode: "missing_goal_payoff" };
  if (directBall < 0.30 || maximumBallGap > allowedDirectBallGap) return { usable: false, mode: "ball_not_visibly_continuous" };
  if (!stableCamera) return { usable: false, mode: "unstable_camera" };
  return { usable: false, mode: "insufficient_joint_framing" };
}

const tacticalEvidenceWords = new Set(["assist", "clearance", "cross", "dribble", "header", "offside", "save", "shot", "tackle", "volley"]);

export function playerOnlyEvidenceAllowed(moment) {
  const action = ["goal", "disallowed_goal", "offside", "var", "save", "shot_on_target", "shot_off_target", "big_chance", "assist", "free_kick", "penalty"].includes(moment.eventType);
  return !action && (moment.eventType === "celebration" || moment.storyPhase === "reaction"
    || moment.role === "reaction" || moment.trackingBrief?.cameraMode === "reaction");
}

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
export function splitCaptionChunks(value, maximumWords = 3, maximumCharacters = 18) {
  const words = String(value || "").replace(/[\r\n]+/g, " ").trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];
  const chunks = [];
  let current = [];
  for (const word of words) {
    const candidate = [...current, word].join(" ");
    if (current.length && (current.length >= maximumWords || candidate.length > maximumCharacters)) {
      chunks.push(current.join(" "));
      current = [word];
    } else {
      current.push(word);
    }
    const punctuationBreak = /[.!?,;:]$/.test(word) && current.length >= 2;
    if (punctuationBreak) {
      chunks.push(current.join(" "));
      current = [];
    }
  }
  if (current.length) {
    const merged = chunks.length ? chunks.at(-1) + " " + current.join(" ") : "";
    if (current.length === 1 && chunks.length && chunks.at(-1).split(/\s+/).length < maximumWords && merged.length <= maximumCharacters) {
      chunks[chunks.length - 1] = merged;
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
