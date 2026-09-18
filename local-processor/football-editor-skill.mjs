import { normalizePayoffEvidence } from "./payoff-evidence.mjs";
export const FOOTBALL_EDITOR_SKILL_VERSION = 12;

export function footballObservationContract() {
  return [
    "Inventory ALL distinct goals and offside/disallowed-goal/VAR incidents throughout the upload. Replays share their live incident's storyId and must not count as additional goals. A final score is a cross-check only, not proof missing goals appear in the footage. Mark disallowed_goal or offside only with visible referee/VAR decision evidence; never infer the verdict from an approximate line.",
    "Act as a football editor before acting as a clip selector. Identify the complete causal action: setup, initiating player, decisive contact, ball flight or continuation, receiving/defending subject, payoff, and resolved ending.",
    "First inventory the entire supplied source. Group each live action, matching replay and immediate reaction under one incident storyId. Camera cuts are shot boundaries, not incident boundaries. Preserve complete actions before estimating duration. Do not label post-shot walking or ordinary build-up as a goal or celebration.",
    "When a goal or save is unclear, inspect the actual contact and outcome before making the claim. A missed local ball detection is not proof the source lacks a ball; conversely, a high-confidence object box is not proof it is the ball. Mark uncertainty explicitly. Never invent a player identity or coordinates to satisfy the requested runtime.",
    "For every non-reaction moment return trackingBrief. trackingBrief must contain primaryPlayerRole, attackDirection (left|right|unclear), cameraMode (stable|joint_follow|ball_flight|goal_hold|reaction), payoffTarget (receiver|defender|goalkeeper|goal_mouth|touchline|celebration|unclear), originTime, contactTime, flightStartTime, handoffTime, payoffStartTime, payoffEndTime, goalFocusX from 0 to 1 or null, annotationStartTime, annotationEndTime, and requiredSubjectsByPhase.",
    "All trackingBrief times are numeric seconds relative to the supplied excerpt. requiredSubjectsByPhase is an ordered array of objects with phase (setup|contact|flight|payoff|reaction) and subjects chosen from ball, initiating_player, receiver, defender, goalkeeper, goal_mouth, and celebration_player.",
    "Before contact, require the ball and initiating player together. During a pass or shot, begin from that player, then hand camera ownership toward the receiving player, defender, goalkeeper, or goalmouth as the ball travels. At a goal, keep the ball trajectory and goalmouth/goalkeeper through the visible result. Player-only framing is valid only after the outcome for reaction or celebration.",
    "Do not guess exact per-frame coordinates. Supply semantic phase times and subjects; the local high-frame-rate tracker executes the camera path.",
    "For a visibly proven goal, save or shot outcome, include trackingBrief.payoffEvidence={verified:true,eventType,startTime,endTime,targetBox:[x1,y1,x2,y2]}. Times use the same excerpt clock as other trackingBrief times. targetBox is the normalized source-image region containing the actual ball/result and relevant goalkeeper, net or receiver, not an unrelated walking player. Choose a continuous interval of at least 0.5 seconds where this result is visible. This is coarse semantic evidence, not a per-frame tracking path. If you cannot verify the result, return payoffEvidence:null. Never infer a visible goal from celebration, a scoreboard, commentary, model knowledge or an estimated percentage of the clip.",
    "The result rectangle must remain valid throughout its stated interval. Use a short interval or return null if a camera cut or pan invalidates it. Do not include an entire oversized net merely to approximate the result location. Never move the rectangle away from actual evidence to make it fit 9:16.",
    "For a goal, primaryPlayerRole must be scorer; contactTime is the LAST attacking-player touch that directly sends the ball into the goal, not the cross, assist, through-ball, earlier pass, nearby defender, or goalkeeper. When the sequence contains a pass followed by a finish, watch through the finish and put contactTime on the finisher's touch. Put annotationStartTime about 0.8-1.4 seconds before that scoring touch and annotationEndTime no later than 0.6 seconds after it so the marker identifies only the scorer.",
    "A goal candidate is not complete unless the footage contains the scorer with the ball at decisive contact, visible ball travel, the goalkeeper or goalmouth payoff, and only then any reaction. Return immediate celebration and replay as separate candidates with the exact same storyId as the live goal action. Never label celebration-only footage as goal evidence.",
  ].join(" ");
}

export function footballAlignmentContract() {
  return [
    "Request tacticalDrawing=map only for a freeze explaining player spacing or shape. It uses a locally calibrated pitch and observed player feet, never invented positions; failed calibration omits the map. The map is approximate, not a measured offside line. Keep it away from the ball and involved players in the video. Prefer pass/run/ball drawings when a map is unnecessary.",
    "Request tacticalDrawing=pass only when explaining a visibly completed player-to-player pass in the scene's opening buildup. This freezes the verified origin phase. The renderer requires both players in that exact frame and consecutive observations of the receiver gaining possession. Otherwise use ball/run/none; never draw an imagined passing option as an actual pass.",
    "Cover every supplied distinct verified goal and decision incident; thirty seconds is only a minimum. Never omit a goal to shorten the edit. Each narrated claim must describe its own candidate, not a different goal in the inventory.",
    "For a useful freeze, request tacticalDrawing=ball to explain an observed pass/shot direction or tacticalDrawing=run to explain the involved player's movement; otherwise none. The local renderer draws a solid ball-direction path or a dashed player-run path only from consecutive observed positions with verified camera registration. It omits uncertain drawings. Never invent coordinates or request an official offside measurement. Keep the freeze tied to the exact narrated action.",
    "Follow the active duration policy. For complete recaps, AI chooses the strongest complete story with a minimum of 60 seconds; the estimated length is not a deadline. Never pad to a midpoint or cut a completed action short to match an estimate. For legacy fixed-range jobs only, respect their explicit range after measured narration is included.",
    "The content writer supplies an exact number of approved beats derived from verified scene capacity. Map every beat exactly once to one primary verified scene; never omit the hook, decisive proof, or conclusion. Extra related scenes may be silent support only.",
    "Keep spoken analysis concise enough for a natural male analyst delivery. Do not rely on frozen padding, repeated footage, or unnaturally fast speech to satisfy duration.",
    "Use player roles only until identities are independently verified. A name in a model hypothesis, story ID or earlier commentary is not evidence. For complete narrated recaps, align visuals to one continuous master voice recording created before editing, from opening hook through conclusion. Show sparse complete headlines in white with one yellow emphasis word, and keep celebrations to 2-3 seconds without caption or effect stacking.",
    "Preserve each candidate's trackingBrief as the camera-direction authority.",
    "Choose evidence whose setup, contact, flight, payoff, and resolved ending support the spoken beat in that order.",
    "Use this event priority whenever the source contains verified evidence: confirmed goal, shot on target, shot off target, save, block, or clear big chance, then other tactical play. A verified goal is the editorial peak, not a bridge to an unrelated later incident.",
    "A goal cluster must be contiguous in edit order: live scoring action -> same-goal immediate celebration and/or same-goal replay -> same-goal reaction. Never place an unrelated action between the goalmouth result and its emotional payoff.",
    "Never pair narration about a pass, shot, save, defensive error, or goal with a different action phase merely because the clip has a similar event label.",
    "Use a highlight only during the analytical phase named by the tracking brief, and only on the initiating or tactically involved player while the ball is also visible.",
    "Make the analysis visibly distinct through an original analytical structure, replacement narration, purposeful reframing, short captions, and evidence-linked treatment. Cosmetic changes alone do not create a new purpose.",
    "Use freeze_analysis only at a verified contact, decision, or payoff frame for 0.4 to 1.0 seconds while narration explains that exact evidence. Use dramatic, replay_blue, or goal_gold grading only to distinguish a hook, forensic replay, or confirmed goal payoff.",
    "All captions and callouts are uppercase, use two to four words, enter with restrained eased motion, and remain inside the mobile safe area without covering the ball, involved player, or goalmouth.",
    "Use one large, thick red ring only on the locally verified scorer or key shooter shortly before decisive contact, then remove it immediately after contact so the camera can follow the ball. Omit the marker when identity or tracking is uncertain. Do not use other colors, a spotlight, filled halo, decorative target, or a marker on an unrelated player.",
    "Every segment must include transformationReason explaining how its narration, crop, freeze, annotation, timing, or grade supports criticism, commentary, or instruction. Never claim that an effect guarantees fair use or use effects merely to evade matching systems.",
  ].join(" ");
}

export function footballQualityContract() {
  return [
    "Verify the active duration policy using the rendered MP4 and measured synthesized speech, not an estimate from source timestamps. Complete recap edits must be at least 60 seconds, may run beyond a 120-second guide when the story needs it, end naturally, and have no filler padding; legacy jobs retain their explicit range.",
    "Audit every action as setup -> contact -> ball travel -> payoff, not as unrelated sampled frames.",
    "The crop must begin with the initiating player and football together, pan smoothly in the attack direction, hand off only to a verified receiver/defender/goalkeeper or the goalmouth, and hold the visible result before any celebration cut.",
    "Reject a marker on a spectator, official, substitute, unrelated player, or empty grass; a marker must remain attached to one involved player identity and disappear when evidence is uncertain.",
    "Reject a goal segment that omits the scorer at decisive contact, ball flight, goalkeeper or goalmouth payoff, or cuts directly from build-up to celebration.",
    "When a goal appears, reject an edit that cuts to an unrelated incident before showing the same goal's immediate celebration or replay proof. The result must hold long enough to read before the emotional payoff begins.",
    "For a shot on target, shot off target, big chance, or save, require shooter and ball at contact, visible travel, goalkeeper or goalmouth result, and a brief resolved hold. Reject a clip that begins after the shot or ends before the outcome.",
    "Reject false ball reacquisition in the stands, advertising, crowd, or clothing, and reject narration whose claimed action phase is not on screen.",
    "Reject WHAT A FINISH, GOAL, ON TARGET or save graphics over walking players or buildup. Event effects and captions require the actual result to be visible in the final portrait crop, not only in the uncropped source.",
    "Reject an edit that mainly republishes the source sequence with decorative filters. Each borrowed passage must be no longer than reasonably necessary for its analytical point, and every freeze, grade, speed change, annotation, caption, or sound must serve the new commentary.",
  ].join(" ");
}

export function normalizeReviewedTrackingBrief(review, moment, eventType) {
  const hasReviewedBrief = Boolean(review?.trackingBrief && typeof review.trackingBrief === "object");
  const reviewedPayoff = review?.payoffEvidence ?? review?.trackingBrief?.payoffEvidence;
  if (!hasReviewedBrief) {
    const normalized = normalizeTrackingBrief(moment?.trackingBrief || {}, { eventType }, moment.startTime, moment.endTime, 0);
    if (reviewedPayoff === undefined) return normalized;
    const payoffEvidence = normalizePayoffEvidence(reviewedPayoff, eventType, moment.startTime, moment.endTime, moment.startTime);
    return {
      ...normalized,
      payoffEvidence,
      goalFocusX: eventType === "goal" && payoffEvidence
        ? Number(((payoffEvidence.targetBox[0] + payoffEvidence.targetBox[2]) / 2).toFixed(6))
        : normalized.goalFocusX,
    };
  }
  const normalized = normalizeTrackingBrief({
    ...review.trackingBrief,
    payoffEvidence: reviewedPayoff,
  }, { eventType }, moment.startTime, moment.endTime, moment.startTime);
  if (reviewedPayoff !== undefined || !moment?.trackingBrief?.payoffEvidence) return normalized;
  const payoffEvidence = normalizePayoffEvidence(moment.trackingBrief.payoffEvidence, eventType, moment.startTime, moment.endTime, 0);
  return {
    ...normalized,
    payoffEvidence,
    goalFocusX: eventType === "goal" && payoffEvidence
      ? Number(((payoffEvidence.targetBox[0] + payoffEvidence.targetBox[2]) / 2).toFixed(6))
      : normalized.goalFocusX,
  };
}

export function expandMomentToReviewedAction(moment, review, eventType, reviewWindowEnd) {
  if (!["goal", "disallowed_goal", "save", "shot_on_target", "shot_off_target", "big_chance"].includes(eventType)) return moment;
  const brief = review?.trackingBrief && typeof review.trackingBrief === "object" ? review.trackingBrief : {};
  const payoff = review?.payoffEvidence ?? brief.payoffEvidence;
  const relativeTimes = [brief.contactTime, brief.flightStartTime, brief.handoffTime,
    brief.payoffStartTime, brief.payoffEndTime, payoff?.startTime, payoff?.endTime]
    .map(Number).filter(Number.isFinite);
  if (!relativeTimes.length) return moment;
  const start = Number(moment.startTime), oldEnd = Number(moment.endTime), limit = Number(reviewWindowEnd);
  if (![start, oldEnd, limit].every(Number.isFinite)) return moment;
  const reviewedEnd = start + Math.max(...relativeTimes);
  const contact = Number(brief.contactTime);
  const contactAbsolute = Number.isFinite(contact) ? start + contact : undefined;
  const tail = eventType === "goal" || eventType === "disallowed_goal" ? .8 : .55;
  const expandedEnd = Number(Math.min(limit, reviewedEnd + tail).toFixed(3));
  if (expandedEnd <= oldEnd + .08) return moment;
  if (Number.isFinite(contactAbsolute) && expandedEnd < contactAbsolute + .55) return moment;
  return {
    ...moment,
    endTime: expandedEnd,
    trackingDecision: undefined,
    selectedForFinalVideo: false,
    boundaryCorrection: {
      ...(moment.boundaryCorrection || {}),
      originalStartTime: moment.boundaryCorrection?.originalStartTime ?? start,
      originalEndTime: moment.boundaryCorrection?.originalEndTime ?? oldEnd,
      reason: "extended_through_reviewed_contact_flight_and_payoff",
    },
  };
}

export function normalizeTrackingBrief(raw, item, startTime, endTime, offset = 0) {
  const source = raw && typeof raw === "object" ? raw : {};
  const duration = Math.max(0.001, endTime - startTime);
  const reaction = item?.eventType === "celebration" || item?.storyPhase === "reaction";
  const allowedCameraModes = new Set(["stable", "joint_follow", "ball_flight", "goal_hold", "reaction"]);
  const allowedTargets = new Set(["receiver", "defender", "goalkeeper", "goal_mouth", "touchline", "celebration", "unclear"]);
  const relative = (value, fallbackRatio) => {
    const number = Number(value);
    const absolute = Number.isFinite(number) ? offset + number : startTime + duration * fallbackRatio;
    return Number(Math.min(endTime, Math.max(startTime, absolute)).toFixed(3));
  };
  const originTime = relative(source.originTime, 0.06);
  const contactTime = relative(source.contactTime, reaction ? 0.18 : 0.34);
  const flightStartTime = Math.max(contactTime, relative(source.flightStartTime, 0.38));
  const handoffTime = Math.max(flightStartTime, relative(source.handoffTime, 0.50));
  const payoffStartTime = Math.max(handoffTime, relative(source.payoffStartTime, 0.68));
  const payoffEndTime = Math.max(payoffStartTime, relative(source.payoffEndTime, 0.94));
  const suppliedAnnotationStart = Number(source.annotationStartTime);
  const suppliedAnnotationEnd = Number(source.annotationEndTime);
  const annotationStartTime = item?.eventType === "goal" && !Number.isFinite(suppliedAnnotationStart)
    ? Number(Math.max(startTime, contactTime - 1.2).toFixed(3))
    : relative(source.annotationStartTime, 0.08);
  const annotationEndTime = item?.eventType === "goal" && !Number.isFinite(suppliedAnnotationEnd)
    ? Number(Math.min(endTime, contactTime + 0.45).toFixed(3))
    : Math.max(annotationStartTime, Math.min(contactTime + 0.65, relative(source.annotationEndTime, 0.42)));
  const goalFocus = Number(source.goalFocusX);
  const allowedSubjects = new Set(["ball", "initiating_player", "receiver", "defender", "goalkeeper", "goal_mouth", "celebration_player"]);
  const requiredSubjectsByPhase = (Array.isArray(source.requiredSubjectsByPhase) ? source.requiredSubjectsByPhase : [])
    .flatMap((entry) => {
      const phase = String(entry?.phase || "");
      if (!["setup", "contact", "flight", "payoff", "reaction"].includes(phase)) return [];
      const subjects = (Array.isArray(entry?.subjects) ? entry.subjects : []).map(String).filter((subject) => allowedSubjects.has(subject));
      return subjects.length ? [{ phase, subjects: [...new Set(subjects)] }] : [];
    });
  if (!requiredSubjectsByPhase.length) {
    requiredSubjectsByPhase.push(
      { phase: "setup", subjects: reaction ? ["celebration_player"] : ["ball", "initiating_player"] },
      { phase: "contact", subjects: reaction ? ["celebration_player"] : ["ball", "initiating_player"] },
      { phase: "flight", subjects: reaction ? ["celebration_player"] : ["ball", item?.eventType === "goal" ? "goal_mouth" : "receiver"] },
      { phase: "payoff", subjects: reaction ? ["celebration_player"] : ["ball", item?.eventType === "goal" ? "goalkeeper" : "receiver"] },
    );
  }
  let payoffEvidence = normalizePayoffEvidence(source.payoffEvidence, item?.eventType, startTime, endTime, offset);
  // attackDirection is defined in source-screen coordinates. A goal rectangle
  // on the opposite half is an internally inconsistent model response, not a
  // usable camera instruction. Correct the common horizontal inversion while
  // preserving the reviewed box's size, height, and timing.
  if (item?.eventType === "goal" && payoffEvidence
      && ["left", "right"].includes(source.attackDirection)) {
    const [x1, y1, x2, y2] = payoffEvidence.targetBox;
    const center = (x1 + x2) / 2;
    const opposite = (source.attackDirection === "right" && center < .45)
      || (source.attackDirection === "left" && center > .55);
    if (opposite) {
      payoffEvidence = {
        ...payoffEvidence,
        targetBox: [
          Number((1 - x2).toFixed(6)), y1,
          Number((1 - x1).toFixed(6)), y2,
        ],
      };
    }
  }
  // The payoff rectangle is a time-bounded, explicitly verified source-image
  // observation. goalFocusX is only a coarse directing hint, so reconcile it
  // to that stronger evidence instead of allowing two model fields to make an
  // otherwise valid goal impossible to track.
  const verifiedGoalFocus = item?.eventType === "goal" && payoffEvidence
    ? Number(((payoffEvidence.targetBox[0] + payoffEvidence.targetBox[2]) / 2).toFixed(6))
    : Number.isFinite(goalFocus) ? Math.min(1, Math.max(0, goalFocus)) : null;
  return {
    version: FOOTBALL_EDITOR_SKILL_VERSION,
    primaryPlayerRole: String(source.primaryPlayerRole || (reaction ? "celebration_player" : item?.eventType === "goal" ? "scorer" : "initiating_player")).slice(0, 48),
    attackDirection: ["left", "right", "unclear"].includes(source.attackDirection) ? source.attackDirection : "unclear",
    cameraMode: allowedCameraModes.has(source.cameraMode) ? source.cameraMode : reaction ? "reaction" : item?.eventType === "goal" ? "goal_hold" : "joint_follow",
    payoffTarget: allowedTargets.has(source.payoffTarget) ? source.payoffTarget : item?.eventType === "goal" ? "goal_mouth" : reaction ? "celebration" : "unclear",
    originTime, contactTime, flightStartTime, handoffTime, payoffStartTime, payoffEndTime,
    payoffEvidence,
    goalFocusX: verifiedGoalFocus,
    annotationStartTime, annotationEndTime,
    requiredSubjectsByPhase,
  };
}
