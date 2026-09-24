export const SHORT_FORM_VERSION = 1;

export function shortFormWritingContract(matchContext = null) {
  const verifiedEntities = matchContext?.status === "verified"
    ? [
      matchContext.homeTeam,
      matchContext.awayTeam,
      ...(matchContext.goals || []).flatMap((goal) => [goal.scorer, goal.assist, goal.opposingGoalkeeper]),
    ].filter(Boolean)
    : [];
  return [
    "Write concise, connected football analysis for a continuous master narration, using only brief natural pauses at contact, ball flight, and celebration.",
    verifiedEntities.length
      ? `IDENTITY POLICY: externally grounded match context verified only these exact names: ${JSON.stringify(verifiedEntities)} and final score ${matchContext.finalScore}. Use no other player/team name, initial, nickname, alias, or score. A verified scorer, assister, or goalkeeper name may describe only the incident binding supplied for that exact evidence candidate.`
      : "IDENTITY POLICY: use player roles only: the winger, striker, defender, goalkeeper, home side, visitors. Do not use ANY player or team names, initials, nicknames or scorelines. No identity has been independently verified. Names inside IDs, descriptions, prior narration or model knowledge are NOT identity evidence.",
    "Explain one visible cause or decision per gameplay beat, in 8-16 natural English words. Reaction beats need at most 4 words; a quiet reaction is preferred. Never narrate a player's sliding celebration just to fill time.",
    "captionText is a separate punchy, complete 2-4-word headline, NOT a chopped excerpt of narration. No dangling prepositions or fragments like INSIDE FROM THE. Avoid generic repeated hype.",
    "Open immediately with a question tied to the strongest visible outcome, then sustain curiosity through the full buildup. End with the strongest payoff or a 2-3 second same-incident reaction, not unrelated close-ups.",
    "When moving to a different incident, provide short truthful context such as NEXT BIG CHANCE. Do not claim a response or comeback unless the verified sequence proves it.",
  ].join(" ");
}

export function conciseCaption(value) {
  const text = String(value || "").replace(/[{}\\\r\n]/g, " ").replace(/\s+/g, " ").trim().toLocaleUpperCase("en-US");
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length < 2 || words.length > 4 || text.length > 28) return "";
  if (/\b(?:THE|A|AN|FROM|WITH|FOR|INTO|OF|AT|BY|AND|TO|IS|ARE)[.!?]*$/.test(text)) return "";
  return text;
}

export function normalizeCaptionHeadline(value, role = "analysis") {
  const supplied = conciseCaption(value);
  if (supplied) return supplied;
  const fallback = {
    hook: "MATCH TURNING POINTS",
    setup: "THE OPENING MOVE",
    analysis: "WHY IT WORKED",
    evidence: "DECISIVE EVIDENCE",
    turn: "MOMENTUM SHIFTS",
    conclusion: "THE FINAL LESSON",
  };
  return fallback[String(role || "analysis")] || "THE KEY MOMENT";
}
export function shortReactionCandidates(candidates, maximumSeconds = 3) {
  return candidates.map((moment) => moment.eventType === "celebration" || moment.storyPhase === "reaction"
    ? { ...moment, endTime: Math.min(moment.endTime, moment.startTime + maximumSeconds), playbackRate: 1 }
    : moment);
}

export function sparseCaptionCues(moment, outputLength, payoffWindow = null) {
  if (moment?.suppressCaption) return [];
  const reaction = moment.eventType === "celebration" || moment.storyPhase === "reaction";
  if (reaction) return []; // Let the emotional payoff breathe.
  const fallback = { goal: "THE DECISIVE TOUCH", save: "QUICK REACTIONS", big_chance: "A BIG CHANCE", shot_on_target: "TESTING THE KEEPER" };
  const supplied = conciseCaption(moment.onScreenText);
  const claimsOutcome = /\b(?:GOAL|FINISH|SCORES?|SCORED|SAVED|DENIED|TARGET)\b/.test(supplied);
  const text = claimsOutcome ? "WATCH THE BUILDUP" : supplied || fallback[moment.eventType] || "SPACE OPENS UP";
  const duration = Math.min(1.5, outputLength * 0.30);
  const cues = [{ text, start: 0.12, end: Math.min(outputLength - 0.1, 0.12 + duration) }];
  const payoff = { goal: "WHAT A FINISH", save: "DENIED BY THE KEEPER", big_chance: "SO CLOSE", shot_on_target: "ON TARGET" }[moment.eventType];
  const start = Number(payoffWindow?.start);
  if (!moment.suppressPayoffCaption && payoff && payoffWindow?.verified === true && Number.isFinite(start) && start >= cues[0].end + 0.3 && start < outputLength - 0.4) {
    cues.push({ text: payoff, start, end: Math.min(outputLength - 0.08, payoffWindow.end, start + 1.1) });
  }
  return cues;
}

export function subtitlePhraseChunks(value, maximumWords = 6, maximumCharacters = 48) {
  const words = String(value || "")
    .replace(/[{}\\\r\n]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLocaleUpperCase("en-US")
    .split(/\s+/)
    .filter(Boolean);
  const danglingEnd = /^(?:THE|A|AN|AND|OR|BUT|TO|OF|IN|ON|AT|BY|FOR|WITH|FROM|INTO|OVER|UNDER|BEYOND|DOWN|UP|AS|WHEN|WHERE|THAT|WHO|WHICH|TAKES|FINDS|FORCES|SENDS|CURLS|DRIVES|PLACES|PUSHES|DELIVERS|DIRECTS|MEETS|BEATS)$/;
  const normalizedWord = (word) => String(word || "").replace(/[^A-Z0-9À-ÖØ-Þ'-]/g, "");
  const minimumGroups = Math.max(1, Math.ceil(words.length / maximumWords));
  for (let groupCount = minimumGroups; groupCount <= Math.max(minimumGroups, Math.ceil(words.length / 2)); groupCount += 1) {
    const chunks = [];
    let cursor = 0;
    for (let group = 0; group < groupCount; group += 1) {
      const remainingWords = words.length - cursor;
      const remainingGroups = groupCount - group;
      let take = Math.ceil(remainingWords / remainingGroups);
      while (take > 3 && words.slice(cursor, cursor + take).join(" ").length > maximumCharacters) take -= 1;
      chunks.push(words.slice(cursor, cursor + take));
      cursor += take;
    }
    if (chunks.length > 1 && chunks.at(-1).length === 1 && chunks.at(-2).length > 3) {
      chunks.at(-1).unshift(chunks.at(-2).pop());
    }
    for (let index = 0; index < chunks.length - 1; index += 1) {
      while (chunks[index].length > 2 && danglingEnd.test(normalizedWord(chunks[index].at(-1)))) {
        chunks[index + 1].unshift(chunks[index].pop());
      }
      const articleBeforeModifier = /^(?:THE|A|AN)$/;
      if (chunks[index].length > 3 && articleBeforeModifier.test(normalizedWord(chunks[index].at(-2)))) {
        chunks[index + 1].unshift(chunks[index].pop());
        chunks[index + 1].unshift(chunks[index].pop());
      }
    }
    if (chunks.every((chunk) => chunk.length >= 2 && chunk.length <= maximumWords)) return chunks;
  }
  return words.length ? [words] : [];
}

function subtitleAccent(moment) {
  if (moment?.isReplay || moment?.storyPhase === "replay" || moment?.effect === "replay_treatment") return "&H00FFB875&";
  if (moment?.eventType === "goal") return "&H004DD8FF&";
  if (moment?.eventType === "save") return "&H00FFE65D&";
  if (["setup", "build_up", "analysis"].includes(String(moment?.role)) || moment?.storyPhase === "build_up") return "&H00C2F673&";
  return "&H004A9EFF&";
}

function subtitleEmphasisIndex(words, moment) {
  const scorer = String(moment?.verifiedIdentity?.scorer || "").trim().toLocaleUpperCase("en-US").split(/\s+/).at(-1);
  const priorities = [scorer, "GOAL", "FINISH", "SCORES", "SAVE", "DENIED", "CROSS", "PASS", "SPACE", "SHOT", "EQUALIZER", "WINNER"].filter(Boolean);
  for (const priority of priorities) {
    const index = words.findIndex((word) => word.replace(/[^A-Z0-9À-ÖØ-Þ'-]/g, "") === priority.replace(/[^A-Z0-9À-ÖØ-Þ'-]/g, ""));
    if (index >= 0) return index;
  }
  const stop = /^(?:THE|A|AN|AND|OR|BUT|TO|OF|IN|ON|AT|BY|FOR|WITH|FROM|IS|ARE|WAS|WERE|IT|THIS|THAT)$/;
  for (let index = words.length - 1; index >= 0; index -= 1) if (!stop.test(words[index])) return index;
  return Math.max(0, words.length - 1);
}

export function narrationSubtitleCues(moment, outputLength) {
  const reaction = moment?.eventType === "celebration" || moment?.storyPhase === "reaction" || moment?.role === "reaction";
  const commentary = String(moment?.commentary || "").trim();
  if (moment?.suppressCaption || reaction || !commentary || !(outputLength > 0.8)) return [];
  const chunks = subtitlePhraseChunks(commentary);
  if (!chunks.length) return [];
  const start = 0.16;
  const end = Math.max(start + 0.4, outputLength - 0.12);
  const usable = end - start;
  const totalWords = chunks.reduce((sum, words) => sum + words.length, 0);
  let cursor = start;
  return chunks.map((words, index) => {
    const cueStart = cursor;
    const cueEnd = index === chunks.length - 1 ? end : cursor + usable * (words.length / totalWords);
    cursor = cueEnd;
    return {
      text: words.join(" "),
      start: cueStart,
      end: cueEnd,
      emphasisIndex: subtitleEmphasisIndex(words, moment),
      accent: subtitleAccent(moment),
      animatedSubtitle: true,
    };
  });
}

function assTime(seconds) {
  const cs = Math.max(0, Math.round(seconds * 100));
  return `${Math.floor(cs / 360000)}:${String(Math.floor(cs / 6000) % 60).padStart(2, "0")}:${String(Math.floor(cs / 100) % 60).padStart(2, "0")}.${String(cs % 100).padStart(2, "0")}`;
}

export function captionAss(cues, y = 1420, width = 1080, height = 1920) {
  const header = `[Script Info]\nScriptType: v4.00+\nPlayResX: ${width}\nPlayResY: ${height}\nScaledBorderAndShadow: yes\nWrapStyle: 2\n\n[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\nStyle: Main,Arial,62,&H00FFFFFF,&H004DD8FF,&H00101010,&H80000000,-1,0,0,0,100,100,0,0,1,4,2,5,90,90,150,1\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n`;
  return header + cues.map((cue) => {
    const words = String(cue.text).replace(/[{}\\\r\n]/g, " ").trim().split(/\s+/);
    const emphasisIndex = Number.isInteger(cue.emphasisIndex) ? Math.max(0, Math.min(words.length - 1, cue.emphasisIndex)) : words.length - 1;
    const accent = /^&H[0-9A-F]{8}&$/i.test(String(cue.accent || "")) ? cue.accent : "&H004DD8FF&";
    const rendered = words.map((word, index) => index === emphasisIndex ? `{\\c${accent}}${word}{\\c&H00FFFFFF&}` : word);
    if (String(cue.text).length > 27 && rendered.length >= 5) rendered.splice(Math.ceil(rendered.length / 2), 0, "\\N");
    const phrase = rendered.join(" ").replace(" \\N ", "\\N");
    const size = String(cue.text).length > 30 ? 52 : String(cue.text).length > 23 ? 56 : 62;
    const centerX = Math.round(width / 2);
    const transform = cue.animatedSubtitle ? "\\fscx92\\fscy92\\t(0,150,\\fscx100\\fscy100)" : "";
    return `Dialogue: 0,${assTime(cue.start)},${assTime(cue.end)},Main,,0,0,0,,{\\an5\\fs${size}${transform}\\move(${centerX},${y + 14},${centerX},${y},0,170)\\fad(90,110)}${phrase}`;
  }).join("\n") + "\n";
}

export function obviousIdentityProblems(text, verifiedEntities = []) {
  // A secondary guard. The separate draft audit also extracts single names,
  // lowercase names and aliases; this guard is not an identity recognizer.
  const names = String(text || "").match(/\b(?:[A-Z][a-zà-ž]+\s+){1,2}[A-Z][a-zà-ž]+\b|\b[A-Z]{2,5}\b/g) || [];
const normalizeIdentity = (value) => String(value).trim().toLowerCase().replace(/[^a-z0-9\u00c0-\u024f]+/g, " ").replace(/\s+/g, " ");
  const allowed = (Array.isArray(verifiedEntities) ? verifiedEntities : []).map(normalizeIdentity);
  const isVerifiedFragment = (name) => {
    const normalized = normalizeIdentity(name);
    return allowed.some((entity) => entity === normalized
      || (normalized.length >= 5 && entity.includes(normalized))
      || (["fc", "afc", "cf"].includes(normalized) && entity.endsWith(" " + normalized)));
  };
  return names.filter((name) => !["AI", "VAR"].includes(name) && !isVerifiedFragment(name)).map((name) => "unverified_identity:" + name);
}

export function unverifiedNamedEntities(entities, verifiedEntities = []) {
  const roles = new Set(["home side", "away side", "visiting side", "home team", "away team", "visitors", "opposition", "attacker", "winger", "striker", "forward", "defender", "goalkeeper", "keeper", "midfielder", "runner", "full back", "centre back", "center back", "player", "players", "teammate", "teammates", "referee", "scorer"]);
  const verified = new Set((Array.isArray(verifiedEntities) ? verifiedEntities : []).map((entity) => String(entity).trim().toLowerCase()));
  return (Array.isArray(entities) ? entities : []).filter((entity) => {
    const normalized = String(entity).trim().toLowerCase().replace(/^(?:the|a|an)\s+/, "").replace(/-/g, " ").replace(/\s+/g, " ");
    return !roles.has(normalized) && !verified.has(String(entity).trim().toLowerCase());
  });
}
