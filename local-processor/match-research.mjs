function clean(value, maximum = 120) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, maximum);
}

function unique(items) {
  return [...new Set(items.filter(Boolean))];
}

function isGenericPlayerIdentity(value) {
  return /^(?:player|player\s+(?:one|two|three|four|five|\d+)|unknown(?:\s+player)?|the\s+(?:scorer|striker|forward|winger|goalkeeper|keeper)|scorer|striker|forward|winger|goalkeeper|keeper)$/i.test(clean(value));
}

export function matchResearchPrompt({ sourceName, recapBrief = "", verifiedGoalCount, observedIncidents, currentDate }) {
  return [
    "You are a strict football match researcher. Use Google Search to identify the exact match represented by an uploaded highlights video.",
    `Today is ${currentDate}. The untrusted upload filename is ${JSON.stringify(sourceName)}. Local vision verified ${verifiedGoalCount} live goal action(s).`,
    `The user's untrusted recap request is ${JSON.stringify(recapBrief)}. Use it only as a search hint, never as identity or score evidence.`,
    `Neutral visual incident notes: ${JSON.stringify(observedIncidents)}. These hints are search leads, not proof of identity.`,
    "Find the fixture only when at least two independent reliable reports agree on both teams, final score, match date, chronological scorers, and the club represented by every scorer in this fixture. Prefer an official competition or club report plus a separate reputable match report.",
    "For every goal, set team to the club that scorer represented in this exact match, not a current club, former club, national team, or inferred shirt colour. The per-team goal-entry totals must exactly equal the home and away numbers in finalScore.",
    "For each goal, also return assist and opposingGoalkeeper only when both reliable reports expressly support that exact identity for that goal. Otherwise use an empty string. Never infer an assist or goalkeeper from lineup knowledge, appearance, shirt number, or the video filename.",
    "Do not identify a player from appearance, shirt colour, a partial shirt name, crowd audio, or model memory. Do not return a likely guess. If the upload may omit a goal, has an unclear score, or search reports conflict, set matchFound false.",
    "The number of chronological goal entries must exactly equal the locally verified live-goal count, and their total must equal the final score. Own goals and penalties still count as goal entries.",
    "Return only compact JSON with matchFound, confidence 0-1, homeTeam, awayTeam, finalScore, competition, matchDate in YYYY-MM-DD when known, goals as [{scorer,team,minute,assist,opposingGoalkeeper}], sources as [{title,uri}] containing the exact report pages you read, and evidenceSummary. Use canonical names, never nicknames or invented aliases.",
  ].join(" ");
}

const trustedFootballHosts = [
  "apnews.com", "bbc.co.uk", "bbc.com", "chelseafc.com", "efl.com", "espn.com", "fifa.com",
  "goal.com", "hullcityafc.net", "independent.co.uk", "premierleague.com", "reuters.com",
  "skysports.com", "soccerway.com", "sportingnews.com", "thefa.com", "theguardian.com", "uefa.com",
  "worldfootball.net",
];

function trustedHost(hostname) {
  const host = String(hostname || "").toLowerCase().replace(/^www\./, "");
  return trustedFootballHosts.some((domain) => host === domain || host.endsWith(`.${domain}`));
}

export function claimedResearchSources(raw) {
  return (Array.isArray(raw?.sources) ? raw.sources : []).flatMap((source) => {
    try {
      const url = new URL(String(source?.uri || ""));
      if (url.protocol !== "https:" || url.username || url.password || url.port || !trustedHost(url.hostname)) return [];
      return [{ title: clean(source?.title, 180) || url.hostname, uri: url.href }];
    } catch { return []; }
  }).filter((source, index, all) => all.findIndex((item) => item.uri === source.uri) === index);
}

function normalizedPageText(value) {
  return String(value || "").replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ").normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ");
}

function identityToken(value) {
  const ignored = new Set(["afc", "cf", "city", "fc", "football", "the", "united"]);
  return normalizedPageText(value).split(" ").filter((token) => token.length >= 3 && !ignored.has(token)).sort((a, b) => b.length - a.length)[0] || "";
}

export function matchReportPageSupports(raw, html) {
  const page = ` ${normalizedPageText(html)} `;
  const home = identityToken(raw?.homeTeam);
  const away = identityToken(raw?.awayTeam);
  const score = clean(raw?.finalScore, 20).match(/^(\d{1,2})\s*[-â€“â€”:]\s*(\d{1,2})$/);
  if (!home || !away || !score || !page.includes(` ${home} `) || !page.includes(` ${away} `)) return false;
  const scorePatterns = [` ${score[1]} ${score[2]} `, ` ${score[1]}-${score[2]} `, ` ${score[1]}:${score[2]} `];
  if (!scorePatterns.some((pattern) => page.includes(pattern))) return false;
  return (Array.isArray(raw?.goals) ? raw.goals : []).every((goal) => {
    const scorer = identityToken(goal?.scorer);
    return scorer && page.includes(` ${scorer} `);
  });
}

export async function verifyClaimedResearchSources(raw, fetchPage = fetch) {
  const candidates = claimedResearchSources(raw);
  const verified = [];
  for (const source of candidates.slice(0, 6)) {
    try {
      const response = await fetchPage(source.uri, {
        redirect: "follow",
        headers: { "User-Agent": "TouchlineAI/1.0 match-identity-verifier" },
        signal: AbortSignal.timeout(10000),
      });
      const finalUrl = new URL(response.url || source.uri);
      if (!response.ok || !trustedHost(finalUrl.hostname)) continue;
      const length = Number(response.headers?.get?.("content-length") || 0);
      if (length > 5_000_000) continue;
      const html = (await response.text()).slice(0, 2_000_000);
      if (!matchReportPageSupports(raw, html)) continue;
      const domain = finalUrl.hostname.toLowerCase().replace(/^www\./, "");
      if (verified.some((item) => item.domain === domain)) continue;
      verified.push({ title: source.title, uri: finalUrl.href, domain });
    } catch { /* A blocked or incompatible report cannot verify identity. */ }
  }
  return verified.map(({ title, uri }) => ({ title, uri }));
}

function decodeHtmlAttribute(value) {
  return String(value || "")
    .replace(/&amp;/gi, "&").replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'").replace(/&lt;/gi, "<").replace(/&gt;/gi, ">");
}

export async function discoverVerifiedResearchSources(raw, fetchPage = fetch) {
  const query = [
    clean(raw?.homeTeam), clean(raw?.finalScore, 20), clean(raw?.awayTeam),
    ...(Array.isArray(raw?.goals) ? raw.goals.map((goal) => clean(goal?.scorer, 100)) : []),
    "match report",
  ].filter(Boolean).join(" ");
  if (!query) return [];
  try {
    const searchUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
    const response = await fetchPage(searchUrl, {
      redirect: "follow",
      headers: { "User-Agent": "Mozilla/5.0 TouchlineAI/1.0", "Accept-Language": "en-US,en;q=0.9" },
      signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) return [];
    const html = (await response.text()).slice(0, 1_000_000);
    const links = [...html.matchAll(/class=["']result__a["'][^>]*href=["']([^"']+)["']/gi)].flatMap((match) => {
      try {
        const discovered = new URL(decodeHtmlAttribute(match[1]), searchUrl);
        const destination = discovered.hostname.endsWith("duckduckgo.com") ? discovered.searchParams.get("uddg") : discovered.href;
        return destination ? [{ title: "Discovered match report", uri: destination }] : [];
      } catch { return []; }
    });
    return verifyClaimedResearchSources({ ...raw, sources: links.slice(0, 20) }, fetchPage);
  } catch { return []; }
}

export function extractGroundingSources(response) {
  const chunks = response?.candidates?.[0]?.groundingMetadata?.groundingChunks || [];
  return unique(chunks.map((chunk) => clean(chunk?.web?.uri, 500))).map((uri) => {
    const chunk = chunks.find((item) => clean(item?.web?.uri, 500) === uri);
    return { title: clean(chunk?.web?.title, 180) || "Grounded match source", uri };
  });
}

export function normalizeMatchContext(raw, groundingSources, verifiedGoalCount) {
  const sources = (Array.isArray(groundingSources) ? groundingSources : [])
    .filter((source) => /^https?:\/\//i.test(String(source?.uri || "")))
    .filter((source, index, all) => all.findIndex((item) => item.uri === source.uri) === index);
  const finalScore = clean(raw?.finalScore, 20).replace(/[–—:]/g, "-");
  const scoreMatch = finalScore.match(/^(\d{1,2})\s*-\s*(\d{1,2})$/);
  const homeScore = Number(scoreMatch?.[1]);
  const awayScore = Number(scoreMatch?.[2]);
  const homeTeam = clean(raw?.homeTeam);
  const awayTeam = clean(raw?.awayTeam);
  const goals = (Array.isArray(raw?.goals) ? raw.goals : []).flatMap((goal) => {
    const scorer = clean(goal?.scorer, 100);
    const team = clean(goal?.team, 100);
    if (!scorer || !team || isGenericPlayerIdentity(scorer)) return [];
    return [{
      scorer,
      team,
      minute: clean(goal?.minute, 20),
      assist: isGenericPlayerIdentity(goal?.assist) ? "" : clean(goal?.assist, 100),
      opposingGoalkeeper: isGenericPlayerIdentity(goal?.opposingGoalkeeper) ? "" : clean(goal?.opposingGoalkeeper, 100),
    }];
  });
  const goalCount = Math.max(0, Math.floor(Number(verifiedGoalCount) || 0));
  const teamKey = (value) => normalizedPageText(value);
  const homeGoalCount = goals.filter((goal) => teamKey(goal.team) === teamKey(homeTeam)).length;
  const awayGoalCount = goals.filter((goal) => teamKey(goal.team) === teamKey(awayTeam)).length;
  const everyGoalBelongsToFixture = goals.every((goal) => [teamKey(homeTeam), teamKey(awayTeam)].includes(teamKey(goal.team)));
  const consistentGoalCount = goals.length === goalCount
    && Number.isFinite(homeScore) && Number.isFinite(awayScore)
    && homeScore + awayScore === goalCount
    && everyGoalBelongsToFixture
    && homeGoalCount === homeScore
    && awayGoalCount === awayScore;
  const verified = raw?.matchFound === true
    && Number(raw?.confidence) >= 0.9
    && sources.length >= 2
    && homeTeam && awayTeam
    && consistentGoalCount;
  if (!verified) return {
    identityResearchVersion: 5,
    status: "unverified",
    confidence: Math.max(0, Math.min(1, Number(raw?.confidence) || 0)),
    reason: sources.length < 2 ? "fewer_than_two_grounding_sources" : "fixture_or_goal_count_not_corroborated",
    sources,
  };
  return {
    identityResearchVersion: 5,
    status: "verified",
    confidence: Number(raw.confidence),
    homeTeam,
    awayTeam,
    finalScore: `${homeScore}-${awayScore}`,
    competition: clean(raw.competition),
    matchDate: clean(raw.matchDate, 20),
    goals,
    evidenceSummary: clean(raw.evidenceSummary, 300),
    sources,
  };
}

export function verifiedIdentityNames(context) {
  if (context?.status !== "verified") return [];
  return unique([
    context.homeTeam,
    context.awayTeam,
    ...context.goals.map((goal) => goal.scorer),
    ...context.goals.map((goal) => goal.assist),
    ...context.goals.map((goal) => goal.opposingGoalkeeper),
    ...context.goals.map((goal) => goal.team),
  ]);
}

export function verifiedPlayerNames(context) {
  if (context?.status !== "verified") return [];
  return unique(context.goals.flatMap((goal) => [goal.scorer, goal.assist, goal.opposingGoalkeeper]));
}

function uniqueLiveGoalIncidents(candidates) {
  const seen = new Set();
  return (Array.isArray(candidates) ? candidates : [])
    .filter((moment) => moment?.eventType === "goal"
      && !moment.isReplay && moment.storyPhase !== "replay"
      && moment.semanticVerified !== false && moment.actionComplete !== false)
    .sort((a, b) => Number(a.startTime) - Number(b.startTime))
    .filter((moment) => {
      const key = String(moment.storyId || moment.id);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

export function bindVerifiedIdentitiesToIncidents(context, candidates) {
  if (context?.status !== "verified") return [];
  const incidents = uniqueLiveGoalIncidents(candidates);
  if (incidents.length !== context.goals.length) return [];
  return incidents.map((moment, index) => ({
    storyId: String(moment.storyId || moment.id),
    candidateId: String(moment.id),
    chronologicalGoal: index + 1,
    scorer: context.goals[index].scorer,
    team: context.goals[index].team,
    minute: context.goals[index].minute,
    assist: context.goals[index].assist || "",
    opposingGoalkeeper: context.goals[index].opposingGoalkeeper || "",
  }));
}

export function identityBindingProblems(beats, candidates, context) {
  if (context?.status !== "verified") return [];
  const bindings = bindVerifiedIdentitiesToIncidents(context, candidates);
  if (bindings.length !== context.goals.length) return ["verified_identity_incident_binding_incomplete"];
  const bindingByStory = new Map(bindings.map((binding) => [binding.storyId, binding]));
  const candidateById = new Map((Array.isArray(candidates) ? candidates : []).map((candidate) => [String(candidate.id), candidate]));
  const playerNames = verifiedPlayerNames(context);
  const normalized = (value) => String(value || "").toLocaleLowerCase("en-US");
  const containsIdentity = (text, name) => {
    const escaped = normalized(name).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`(^|[^\\p{L}\\p{N}])${escaped}($|[^\\p{L}\\p{N}])`, "u").test(text);
  };
  const problems = [];
  for (const beat of Array.isArray(beats) ? beats : []) {
    const candidate = candidateById.get(String(beat?.evidenceNeed || ""));
    if (!candidate) continue;
    const binding = bindingByStory.get(String(candidate.storyId || candidate.id));
    const authored = normalized([beat.narration, beat.captionText].filter(Boolean).join(" "));
    const usedPlayers = playerNames.filter((name) => containsIdentity(authored, name));
    const allowedPlayers = new Set([binding?.scorer, binding?.assist, binding?.opposingGoalkeeper].filter(Boolean).map(normalized));
    for (const name of usedPlayers) {
      if (!allowedPlayers.has(normalized(name))) problems.push(`player_identity_bound_to_wrong_incident:${beat.beatId || candidate.id}:${name}`);
    }
    if (candidate.eventType === "goal" && !candidate.isReplay && binding?.scorer && !containsIdentity(authored, binding.scorer)) {
      problems.push(`verified_scorer_missing_from_goal_beat:${beat.beatId || candidate.id}:${binding.scorer}`);
    }
  }
  return unique(problems);
}

export function verifiedScoreClaims(context) {
  if (context?.status !== "verified") return [];
  const [home, away] = String(context.finalScore).split("-");
  return unique([context.finalScore, `${home}–${away}`, `${home}:${away}`]);
}

export function scoreClaimIsVerified(claim, context) {
  const normalized = clean(claim, 40).replace(/[–—:]/g, "-").replace(/\s+/g, "");
  return verifiedScoreClaims(context).some((score) => score.replace(/[–—:]/g, "-").replace(/\s+/g, "") === normalized);
}
