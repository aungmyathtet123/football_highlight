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
