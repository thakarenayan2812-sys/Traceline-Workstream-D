// Normalises C's analytics JSON. Anything missing or malformed becomes
// "not_yet_generated" so panels say so instead of inventing numbers (guide section 15).
export const ANALYTICS_SECTIONS = Object.freeze(
  ["error_map", "crowd_degradation", "stress", "emergency_flags"]);

const OK = new Set(["ok", "stand_in"]);

/** Pure. @returns {Record<string,{status:string,data:any}>} */
export function normalizeAnalytics(raw) {
  const out = {};
  for (const k of ANALYTICS_SECTIONS) {
    const sec = raw && typeof raw === "object" ? raw[k] : null;
    if (sec && OK.has(sec.status) && sec.data != null) out[k] = { status: sec.status, data: sec.data };
    else out[k] = { status: "not_yet_generated", data: null };
  }
  return out;
}

/** Reads the JSON as delivered (caveats included). Returns null when it is missing or unreadable. */
export async function fetchAnalyticsRaw(url, fetchFn = fetch) {
  try {
    const res = await fetchFn(url);
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

export async function loadAnalytics(url, fetchFn = fetch) {
  return normalizeAnalytics(await fetchAnalyticsRaw(url, fetchFn));
}
