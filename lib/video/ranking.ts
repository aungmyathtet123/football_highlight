import type { EventType, FootballMoment } from "./types";

export const EVENT_WEIGHTS: Record<EventType, number> = {
  goal: 100,
  penalty: 95,
  save: 90,
  big_chance: 85,
  assist: 85,
  shot_on_target: 82,
  free_kick: 80,
  var: 76,
  skill: 70,
  dribble: 70,
  tackle: 65,
  celebration: 50,
  normal_play: 15,
};

export function scoreMoment(moment: Omit<FootballMoment, "importanceScore" | "selectedForFinalVideo">): number {
  const clarity = moment.ballVisible ? 5 : -14;
  const subject = moment.mainPlayerVisible ? 4 : -10;
  const confidence = (moment.confidence - 0.5) * 14;
  const duplicatePenalty = moment.duplicateGroup ? -8 : 0;
  return clamp(Math.round(EVENT_WEIGHTS[moment.eventType] + clarity + subject + confidence + duplicatePenalty), 0, 100);
}

export function packTimeline(candidates: FootballMoment[], targetSeconds: number): FootballMoment[] {
  const maximum = Math.min(80, Math.max(1, targetSeconds));
  const unique = deduplicate(candidates)
    .filter((moment) => moment.endTime > moment.startTime && moment.confidence >= 0.5)
    .sort((a, b) => b.importanceScore - a.importanceScore || a.startTime - b.startTime);

  let used = 0;
  const selected = new Set<string>();
  for (const moment of unique) {
    const clipLength = moment.endTime - moment.startTime;
    if (used + clipLength > maximum + 0.25) continue;
    selected.add(moment.id);
    used += clipLength;
    if (used >= maximum - 3) break;
  }

  return candidates.map((moment) => ({ ...moment, selectedForFinalVideo: selected.has(moment.id) }));
}

function deduplicate(candidates: FootballMoment[]) {
  const seen = new Set<string>();
  return candidates.filter((moment) => {
    if (!moment.duplicateGroup) return true;
    if (seen.has(moment.duplicateGroup)) return false;
    seen.add(moment.duplicateGroup);
    return true;
  });
}

export function buildPreviewMoments(sourceDuration: number): FootballMoment[] {
  const safeDuration = Math.max(90, Number.isFinite(sourceDuration) ? sourceDuration : 780);
  const templates: Array<[number, EventType, number, string, string]> = [
    [.08, "skill", 4.1, "Winger beats the first defender", "That first touch opens the lane before the defender can reset."],
    [.18, "save", 4.8, "Quick reaction save at the near post", "The goalkeeper stays compact and reacts the moment the shot leaves the boot."],
    [.31, "big_chance", 5.0, "One-touch chance inside the area", "Watch how the late run arrives between both centre-backs."],
    [.43, "tackle", 3.6, "Last-ditch tackle stops the break", "The defender waits, matches the stride, then wins the ball cleanly."],
    [.56, "goal", 6.4, "Fast combination creates the finish", "The final pass removes two defenders and leaves a first-time finish."],
    [.67, "dribble", 4.0, "Midfielder escapes the press", "A sharp body feint turns pressure into space for the counter."],
    [.78, "free_kick", 5.2, "Dangerous free kick bends toward goal", "The strike clears the wall early and forces a full-stretch reaction."],
    [.89, "goal", 6.8, "Late run ends in a composed finish", "Track the runner here—the movement starts before the back line reacts."],
    [.93, "celebration", 3.2, "Immediate reaction after the finish", "That reaction shows how much the moment means, without overstaying it."],
    [.47, "shot_on_target", 4.2, "Driven effort from the edge of the box", "The early shot catches the defence before it can close the angle."],
    [.73, "assist", 4.4, "Disguised pass splits the back line", "The passer looks wide, then threads the ball through the central gap."],
    [.24, "normal_play", 3.0, "Possession recycled through midfield", "The shape resets before the next attacking phase."],
    [.61, "var", 4.0, "Close decision after contact in the area", "The key question is whether the contact happens before the ball is played."],
    [.37, "penalty", 5.5, "Penalty kick under pressure", "A short run-up keeps the goalkeeper waiting until the final step."],
    [.84, "save", 4.7, "Strong hand keeps out the header", "The goalkeeper shifts early, then gets a firm hand behind the ball."],
  ];

  return templates.map(([ratio, eventType, length, description, commentary], index) => {
    const startTime = Math.max(0, Math.min(safeDuration - length - 1, safeDuration * ratio));
    const base = { id: `moment-${index + 1}`, startTime, endTime: startTime + length, eventType, description, confidence: 0.76 + (index % 5) * 0.04, ballVisible: eventType !== "celebration", mainPlayerVisible: true, recommendedCrop: [{ time: startTime, x: 0.5, y: 0.48, confidence: 0.88 }, { time: startTime + length, x: 0.62, y: 0.46, confidence: 0.84 }], commentary, duplicateGroup: index === 8 ? "late-goal-reaction" : undefined };
    return { ...base, importanceScore: scoreMoment(base), selectedForFinalVideo: false };
  });
}

function clamp(value: number, min: number, max: number) { return Math.min(max, Math.max(min, value)); }
