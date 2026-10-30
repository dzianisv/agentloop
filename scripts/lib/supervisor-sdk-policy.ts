/** Classify only structured OpenCode SDK provider errors; never inspect tool prose. */
export function classifySdkFailure(statusCode?: number, headers: Record<string, string> = {}, responseBody?: string | Record<string, unknown>, retryAfterMs?: number,
  errorName?: string, errorMessage?: string) {
  const lowerHeaders = Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]));
  let body: any;
  try { body = typeof responseBody === "string" ? JSON.parse(responseBody) : responseBody; } catch { body = undefined; }
  if (errorName === "ModelUnavailableError" || /^Model unavailable:/i.test(errorMessage || "")) {
    return { kind: "unavailable" as const, scope: "model" as const, retryAt: new Date(Date.now() + 60_000).toISOString() };
  }
  if (statusCode === 429) {
    const daily = body?.limit_source === "opencode_free_tier" || body?.error?.metadata?.limit_source === "openrouter_free_tier_daily" || body?.metadata?.limit_source === "openrouter_free_tier_daily" || body?.limit_source === "openrouter_free_tier_daily" ||
      body?.error?.metadata?.limit_source === "openrouter/free-tier-daily" || body?.metadata?.limit_source === "openrouter/free-tier-daily";
    const resetHeader = lowerHeaders["x-ratelimit-reset"];
    let retry = lowerHeaders["retry-after"];
    if (!retry && resetHeader && /^\d{10,13}$/.test(resetHeader)) retry = String(Math.max(0, Number(resetHeader) * (resetHeader.length === 10 ? 1000 : 1) - Date.now()) / 1000);
    const ms = Number.isFinite(retryAfterMs) && retryAfterMs! >= 0 ? Date.now() + retryAfterMs! :
      retry && /^\d+(?:\.\d+)?$/.test(retry) ? Date.now() + Number(retry) * 1000 : retry ? Date.parse(retry) : NaN;
    return { kind: daily ? "daily-quota" as const : "rate-limit" as const, scope: daily ? "account" as const : "model" as const,
      retryAt: Number.isFinite(ms) ? new Date(ms).toISOString() : new Date(Date.now() + (daily ? 24 * 60 * 60_000 : 60_000)).toISOString() };
  }
  if (statusCode === 503 || statusCode === 502 || statusCode === 504) return { kind: "unavailable" as const, scope: "model" as const, retryAt: new Date(Date.now() + 60_000).toISOString() };
  if (statusCode === 404) return { kind: "unavailable" as const, scope: "model" as const, retryAt: new Date(Date.now() + 15 * 60_000).toISOString() };
  if (statusCode === 401 || statusCode === 403 || statusCode === 400) return { kind: "blocked" as const, scope: "model" as const };
  if (body?.error || body?._tag && /Error$/.test(body._tag)) return { kind: "blocked" as const, scope: "model" as const };
  return undefined;
}
