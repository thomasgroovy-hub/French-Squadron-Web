const DEFAULT_MAX_KEYS = 50_000;

/**
 * In-memory sliding-window rate limiter (array of hit timestamps per key).
 * The deployment is single-instance (Railway), so process-local state is the
 * right scope; no dependency, no Redis. Counters never keep the process alive
 * and are pruned lazily on access, so memory stays bounded by traffic.
 */
export function createRateLimiter({
  windowMs = 60_000,
  max = 120,
  keyFn = (req) => req.ip || 'unknown',
  message = 'Trop de requêtes depuis votre adresse. Patientez un instant puis réessayez.',
} = {}) {
  const buckets = new Map();
  let lastSweep = Date.now();

  function prune(hits, now) {
    let drop = 0;
    while (drop < hits.length && now - hits[drop] >= windowMs) drop += 1;
    if (drop > 0) hits.splice(0, drop);
  }

  function sweep(now) {
    if (now - lastSweep < windowMs) return;
    lastSweep = now;
    for (const [key, hits] of buckets) {
      if (!hits.length || now - hits[hits.length - 1] >= windowMs) buckets.delete(key);
    }
  }

  return function rateLimit(req, res, next) {
    const now = Date.now();
    sweep(now);

    const key = keyFn(req);
    let hits = buckets.get(key);
    if (!hits) {
      // Beyond the key cap the map stops growing (fail open) rather than
      // letting an attacker spray unique keys until memory runs out.
      if (buckets.size >= DEFAULT_MAX_KEYS) return next();
      hits = [];
      buckets.set(key, hits);
    } else {
      prune(hits, now);
    }

    if (hits.length >= max) {
      const retryAfterMs = Math.max(0, windowMs - (now - hits[0]));
      res.set('Retry-After', String(Math.max(1, Math.ceil(retryAfterMs / 1000))));
      // originalUrl, not req.path: this limiter is often mounted under a
      // prefix, in which case req.path is relative to it ('/permadeath-death')
      // and the /v1 JSON rule would never fire.
      const url = String(req.originalUrl || req.url || '').split('?')[0];
      if (url.startsWith('/v1/') || req.accepts(['html', 'json']) === 'json') {
        return res.status(429).json({ ok: false, error: 'rate-limited' });
      }
      return res.status(429).render('error', { title: 'Trop de requêtes (429)', message });
    }

    hits.push(now);
    return next();
  };
}

/** Key shared by every limiter: client IP, plus the Discord user when known. */
export function clientKey(req) {
  const ip = req.ip || 'unknown';
  const userId = req.session?.user?.id;
  return userId ? `${ip}:${userId}` : ip;
}
