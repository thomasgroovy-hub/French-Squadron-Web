import crypto from 'node:crypto';
import { webConfig } from '../config.js';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * CSRF token derived from the sealed session itself (user id + creation date)
 * rather than stored in it: no extra cookie round-trip, and any change to the
 * session (re-login, expiry) invalidates every token ever rendered.
 */
export function deriveCsrfToken(sessionData, secret = webConfig.sessionSecret) {
  if (!sessionData?.user?.id) return '';
  return crypto
    .createHmac('sha256', secret)
    .update(`csrf:${sessionData.user.id}:${sessionData._created ?? ''}`)
    .digest('hex');
}

function safeEqual(a, b) {
  const left = Buffer.from(String(a), 'utf8');
  const right = Buffer.from(String(b), 'utf8');
  if (left.length !== right.length || left.length === 0) return false;
  return crypto.timingSafeEqual(left, right);
}

/**
 * Rejects every state-changing request that does not carry the session-bound
 * token, either as `_csrf` in the form body or as `x-csrf-token`. The HMAC
 * webhook under `/v1` is exempt: it authenticates with its own signature.
 */
export function csrfProtection({ secret = webConfig.sessionSecret, exemptPaths = ['/v1'] } = {}) {
  return function csrfGuard(req, res, next) {
    if (SAFE_METHODS.has(req.method)) return next();
    const path = req.path;
    if (exemptPaths.some((prefix) => path === prefix || path.startsWith(`${prefix}/`))) return next();
    // No session, no credential to abuse: the route's own requireAuth (redirect
    // to login) is the correct answer for an anonymous POST, and CSRF tokens
    // only exist to protect an authenticated member from foreign pages.
    if (!req.session?.user) return next();

    const expected = deriveCsrfToken(req.session, secret);
    const fromBody = typeof req.body?._csrf === 'string' ? req.body._csrf : '';
    const provided = fromBody || req.get('x-csrf-token') || '';

    if (!expected || !provided || !safeEqual(provided, expected)) {
      if (path.startsWith('/v1/') || req.accepts(['html', 'json']) === 'json') {
        return res.status(403).json({ ok: false, error: 'CSRF token invalid or missing' });
      }
      return res.status(403).render('error', {
        title: 'Requête bloquée (403)',
        message: 'Jeton de sécurité manquant ou expiré. Rechargez la page puis réessayez.',
      });
    }
    return next();
  };
}
