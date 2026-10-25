/**
 * Limiteur à fenêtre glissante en mémoire (par instance).
 * Pour un déploiement multi-instances, remplacer `hits` par Redis (même interface).
 */
const hits = new Map<string, number[]>();
let lastSweep = Date.now();

export function rateLimit(key: string, limit: number, windowMs: number, now = Date.now()) {
  if (now - lastSweep > 60_000) {
    lastSweep = now;
    for (const [k, v] of hits) if (!v.length || now - v[v.length - 1] > 10 * 60_000) hits.delete(k);
  }
  const arr = (hits.get(key) ?? []).filter((t) => now - t < windowMs);
  if (arr.length >= limit) {
    hits.set(key, arr);
    return { ok: false as const, retryAfter: Math.max(1, Math.ceil((windowMs - (now - arr[0])) / 1000)) };
  }
  arr.push(now);
  hits.set(key, arr);
  return { ok: true as const, remaining: limit - arr.length };
}

export function resetRateLimits() {
  hits.clear();
}
