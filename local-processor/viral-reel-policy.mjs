const DECISIVE_EVENTS = new Set(["goal", "disallowed_goal", "save", "shot_on_target", "big_chance"]);
const REACTION_EVENTS = new Set(["celebration"]);

export const VIRAL_REEL_VERSION = 1;

export function isViralReel(settings) {
  return settings?.editStyle === "viral_reel";
}

export function viralReelDurationBounds() {
  return { minimum: 30, maximum: 45 };
}

function verified(moment) {
  if (!moment || moment.semanticVerified !== true || moment.keepDecision === "reject") return false;
  return !["analysis_rejected", "not_tracked", "rejected_after_plan", "semantic_mismatch"].includes(String(moment.trackingDecision || ""));
}

function reaction(moment) {
  return REACTION_EVENTS.has(moment.eventType) || moment.storyPhase === "reaction" || moment.role === "reaction";
}

function duration(moment) {
  const rate = Math.min(1.18, Math.max(0.72, Number(moment.playbackRate || 1)));
  return Math.max(0, Number(moment.endTime) - Number(moment.startTime)) / rate;
}

function actionScore(moment, companions) {
  const eventWeight = { goal: 42, disallowed_goal: 40, save: 30, shot_on_target: 24, big_chance: 20 }[moment.eventType] || 0;
  const companionWeight = Math.min(12, companions.filter(item => item.isReplay || item.storyPhase === "replay").length * 6)
    + Math.min(8, companions.filter(reaction).length * 4)
    + Math.min(10, companions.filter(item => ["var", "offside", "disallowed_goal"].includes(item.eventType)).length * 5);
  return eventWeight + companionWeight
    + Number(moment.importanceScore || 0) * 0.20
    + Number(moment.hookScore || 0) * 0.12
    + Number(moment.narrativeCompleteness || 0) * 0.16
    + Number(moment.visualClarity || 0) * 0.12;
}

function safeCaption(moment, role) {
  if (role === "action") return moment.eventType === "save" ? "WHAT A SAVE" : "WATCH THE PLAY";
  if (role === "replay") return "REPLAY CHECK";
  if (moment.eventType === "var") return "VAR CHECK";
  if (moment.eventType === "offside" || moment.eventType === "disallowed_goal") return "DECISION: OFFSIDE";
  return "";
}

function presentation(moment, role, order, decisionStory) {

  const isReplay = role === "replay";
  const isReaction = role === "reaction";
  const endTime = isReaction ? Math.min(Number(moment.endTime), Number(moment.startTime) + 7) : Number(moment.endTime);
  const freezeReplay = isReplay && decisionStory;
  const freezeAction = role === "action" && DECISIVE_EVENTS.has(moment.eventType);
  return {
    ...moment,
    endTime,
    selectedForFinalVideo: true,
    editOrder: order,
    role,
    commentary: "",
    onScreenText: role === "replay" && decisionStory ? "CHECKING OFFSIDE" : safeCaption(moment, role),
    suppressPayoffCaption: role === "replay" && decisionStory,
    transitionIn: order === 0 ? "cut" : isReplay ? "flash" : "cut",
    transitionDuration: isReplay ? 0.12 : 0.04,
    playerHighlight: role === "action" && moment.mainPlayerVisible !== false,
    tacticalDrawing: "none",
    effect: freezeReplay || freezeAction ? "freeze_analysis" : isReplay ? "replay_treatment" : "none",
    freezeAtPhase: freezeReplay || freezeAction ? "contact" : undefined,
    freezeDuration: freezeReplay ? 0.72 : freezeAction ? 0.90 : undefined,
    playbackRate: isReplay ? 0.82 : role === "action" ? 0.72 : 1,
    colorGrade: isReplay ? "replay_blue" : isReaction ? "dramatic" : moment.eventType === "goal" ? "goal_gold" : "clean",
    soundEffect: isReplay ? "whoosh" : "none",
    eventCallout: "none",
    identityLabel: undefined,
  };
}

export function buildViralReelPlan(candidates) {
  const source = Array.isArray(candidates) ? candidates : [];
  const eligible = source.filter(verified);
  const groups = new Map();
  for (const moment of eligible) {
    const storyId = String(moment.storyId || moment.id || "");
    if (!groups.has(storyId)) groups.set(storyId, []);
    groups.get(storyId).push(moment);
  }
  const ranked = [];
  for (const [storyId, moments] of groups) {
    const liveActions = moments.filter(moment => DECISIVE_EVENTS.has(moment.eventType) && !moment.isReplay && moment.storyPhase !== "replay");
    if (!liveActions.length) continue;
    const action = [...liveActions].sort((a, b) => actionScore(b, moments) - actionScore(a, moments))[0];
    ranked.push({ storyId, moments, action, score: actionScore(action, moments) });
  }
  ranked.sort((a, b) => b.score - a.score || Number(a.action.startTime) - Number(b.action.startTime));
  if (!ranked.length) throw new Error("No semantically and locally verified complete goal, save, or big chance is available for a Viral Reel.");

  const selected = [];
  const selectedStories = [];
  let total = 0;
  let hasDecisionStory = false;
  for (const chosen of ranked) {
    const decisionStory = chosen.moments.some(moment => ["var", "offside", "disallowed_goal"].includes(moment.eventType));
    const buildUp = chosen.moments
      .filter(moment => moment.id !== chosen.action.id && moment.storyPhase === "build_up" && Number(moment.endTime) <= Number(chosen.action.startTime) + 0.25)
      .sort((a, b) => Number(b.endTime) - Number(a.endTime))[0];
    const reactions = chosen.moments.filter(reaction).sort((a, b) => Number(a.startTime) - Number(b.startTime)).slice(0, 2);
    const decisions = chosen.moments
      .filter(moment => !reaction(moment) && ["var", "offside"].includes(moment.eventType))
      .sort((a, b) => Number(a.startTime) - Number(b.startTime)).slice(0, 2);
    const replay = chosen.moments
      .filter(moment => moment.isReplay || moment.storyPhase === "replay")
      .sort((a, b) => Number(b.visualClarity || 0) - Number(a.visualClarity || 0) || Number(a.startTime) - Number(b.startTime))[0];
    const sequence = [];
    if (buildUp && duration(buildUp) >= 4) sequence.push({ moment: buildUp, role: "build_up" });
    sequence.push({ moment: chosen.action, role: "action" });
    for (const moment of reactions.filter(item => Number(item.startTime) < Number(replay?.startTime ?? Infinity))) sequence.push({ moment, role: "reaction" });
    if (replay && replay.id !== chosen.action.id) sequence.push({ moment: replay, role: "replay" });
    for (const moment of decisions) sequence.push({ moment, role: "decision" });
    for (const moment of reactions.filter(item => !sequence.some(entry => entry.moment.id === item.id))) sequence.push({ moment, role: "reaction" });

    const unique = sequence.filter((entry, index, all) => all.findIndex(other => other.moment.id === entry.moment.id) === index);
    const beforeStory = selected.length;
    for (const entry of unique) {
      const next = presentation(entry.moment, entry.role, selected.length, decisionStory);
      const length = duration(next) + (next.effect === "freeze_analysis" ? Number(next.freezeDuration || 0) : 0);
      if (selected.length && total + length > viralReelDurationBounds().maximum) continue;
      selected.push(next);
      total += length;
    }
    if (selected.length > beforeStory) {
      selectedStories.push(chosen.storyId);
      hasDecisionStory ||= decisionStory;
    }
    if (total >= viralReelDurationBounds().minimum) break;
  }
  const byId = new Map(selected.map(moment => [moment.id, moment]));
  return {
    storyId: selectedStories[0],
    storyIds: selectedStories,
    incidentCount: selectedStories.length,
    score: Number(ranked.filter(group => selectedStories.includes(group.storyId)).reduce((sum, group) => sum + group.score, 0).toFixed(2)),
    decisionStory: hasDecisionStory,
    plannedDuration: Number(total.toFixed(3)),
    moments: source.map(moment => byId.get(moment.id) || { ...moment, selectedForFinalVideo: false }),
  };
}