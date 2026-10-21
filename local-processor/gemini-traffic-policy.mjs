// Priority PayGo is shared capacity, not a dedicated reservation. Verify the
// response traffic type rather than assuming the requested tier was granted.
export function geminiTrafficPolicy(env = process.env) {
  const tier = String(env.GEMINI_TRAFFIC_TIER || "standard").trim().toLowerCase();
  if (!["standard", "priority"].includes(tier)) throw new Error("GEMINI_TRAFFIC_TIER must be standard or priority");
  const location = tier === "priority"
    ? String(env.GEMINI_PRIORITY_LOCATION || env.GOOGLE_CLOUD_LOCATION || "global").trim()
    : env.GOOGLE_CLOUD_LOCATION;
  if (tier === "priority" && !["global", "us", "eu"].includes(location)) {
    throw new Error("Priority Gemini requests require global, us, or eu; regional endpoints do not support Priority PayGo");
  }
  return { tier, location, httpOptions: tier === "priority" ? {
    apiVersion: "v1", headers: {
      "X-Vertex-AI-LLM-Request-Type": "shared",
      "X-Vertex-AI-LLM-Shared-Request-Type": "priority",
    },
  } : {} };
}

export function geminiTrafficResult(response, policy) {
  const trafficType = response?.usageMetadata?.trafficType || "UNKNOWN";
  return { requestedTier: policy.tier, location: policy.location, trafficType,
    priorityVerified: trafficType === "ON_DEMAND_PRIORITY",
    downgraded: policy.tier === "priority" && trafficType === "ON_DEMAND" };
}
