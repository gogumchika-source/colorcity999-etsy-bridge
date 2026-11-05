// Private, read-only Studio preflight. Never returns tokens, owner identity, or raw OAuth scopes.
export function evaluateReadiness({ enabled, aiAvailable, kvAvailable, oauthRecord } = {}) {
  const scopes = typeof oauthRecord?.scope === "string"
    ? oauthRecord.scope.trim().split(/\s+/).filter(Boolean)
    : null;
  const scope = scopes === null ? "unverified" : scopes.includes("listings_w") ? "granted" : "missing";
  const ready = enabled && aiAvailable && kvAvailable && scope === "granted";
  return {
    studioPreviewEnabled: Boolean(enabled),
    ownerAuthentication: "verified_for_this_request",
    aiBinding: aiAvailable ? "configured" : "missing",
    oauthRecord: kvAvailable ? (oauthRecord?.refreshToken && oauthRecord?.userId ? "present" : "absent") : "unavailable",
    etsyListingWriteScope: kvAvailable ? scope : "unverified",
    readyForPreview: Boolean(enabled && aiAvailable),
    readyForFutureDraftIntegration: Boolean(ready),
    checks: {
      noEtsyApiCallsPerformed: true,
      noEtsyWritesPerformed: true,
      grantStatusSource: "stored_oauth_record_only"
    },
    note: "The stored Etsy OAuth scope does not prove that the token is currently valid. Use the existing authenticated health check for live connectivity."
  };
}

export async function getStudioReadiness(env) {
  let oauthRecord;
  const kvAvailable = Boolean(env.ETSY_KV && typeof env.ETSY_KV.get === "function");
  if (kvAvailable) {
    try {
      oauthRecord = await env.ETSY_KV.get("etsy:oauth", { type: "json" });
    } catch {
      oauthRecord = undefined;
    }
  }
  return evaluateReadiness({
    enabled: env.STUDIO_ENABLED === "preview",
    aiAvailable: Boolean(env.AI && typeof env.AI.run === "function"),
    kvAvailable,
    oauthRecord
  });
}
