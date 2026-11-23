import crypto from 'node:crypto';
import { webConfig } from '../config.js';
import { deriveCsrfToken } from '../security/csrf.js';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;
/** Server-side session lifetime: matches the cookie's maxAge exactly. */
export const SESSION_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Sids cancelled at logout. A stolen cookie stays cryptographically valid
 * until its TTL, so logout must also blacklist it server-side. Entries carry
 * their own expiry (session creation + max age) and are purged lazily.
 */
const revokedSids = new Map();

function revokeSid(sid) {
  revokedSids.set(sid, Date.now() + SESSION_MAX_AGE_MS);
  const now = Date.now();
  for (const [key, expiry] of revokedSids) {
    if (expiry <= now) revokedSids.delete(key);
  }
}

/** Exported for tests: drops every logout blacklist entry. */
export function clearRevokedSessions() {
  revokedSids.clear();
}

function getKey(secret) {
  return crypto.createHash('sha256').update(secret).digest();
}

/**
 * Encrypts session payload into a tamper-proof base64 token.
 */
export function sealSession(payload, secret = webConfig.sessionSecret) {
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, getKey(secret), iv);
  
  const text = JSON.stringify({
    ...payload,
    _created: Date.now(),
  });
  
  let encrypted = cipher.update(text, 'utf8', 'base64');
  encrypted += cipher.final('base64');
  const tag = cipher.getAuthTag();
  
  return `${iv.toString('base64')}.${tag.toString('base64')}.${encrypted}`;
}

/**
 * Decrypts and validates session token.
 */
export function unsealSession(sealed, secret = webConfig.sessionSecret) {
  if (!sealed || typeof sealed !== 'string') return null;
  const parts = sealed.split('.');
  if (parts.length !== 3) return null;

  try {
    const [ivB64, tagB64, dataB64] = parts;
    const iv = Buffer.from(ivB64, 'base64');
    const tag = Buffer.from(tagB64, 'base64');
    
    const decipher = crypto.createDecipheriv(ALGORITHM, getKey(secret), iv);
    decipher.setAuthTag(tag);
    
    let decrypted = decipher.update(dataB64, 'base64', 'utf8');
    decrypted += decipher.final('utf8');
    
    return JSON.parse(decrypted);
  } catch {
    return null;
  }
}

export function sessionCookieOptions() {
  return {
    httpOnly: true,
    secure: webConfig.isProduction,
    sameSite: 'lax',
    maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
    path: '/',
  };
}

export function sessionMiddleware() {
  return (req, res, next) => {
    const cookieValue = req.cookies?.[webConfig.cookieName];
    const sessionData = unsealSession(cookieValue);

    req.session = sessionData || {};

    // Two conditions invalidate an otherwise well-formed cookie: the server
    // side TTL has passed (cookie maxAge is only a client-side hint), or the
    // session was cancelled at logout.
    if (req.session.user) {
      const created = Number(req.session._created);
      const expired = !Number.isFinite(created) || Date.now() - created > SESSION_MAX_AGE_MS;
      const cancelled = typeof req.session.sid === 'string' && revokedSids.has(req.session.sid);
      if (expired || cancelled) {
        req.session = {};
        if (cookieValue) {
          res.clearCookie(webConfig.cookieName, { path: '/', httpOnly: true, sameSite: 'lax' });
        }
      }
    }

    req.setSession = (data) => {
      req.session = { ...data, sid: crypto.randomBytes(16).toString('hex') };
      const sealed = sealSession(req.session);
      res.cookie(webConfig.cookieName, sealed, sessionCookieOptions());
    };

    req.clearSession = () => {
      if (req.session?.sid) revokeSid(req.session.sid);
      req.session = {};
      res.clearCookie(webConfig.cookieName, {
        path: '/',
        httpOnly: true,
        sameSite: 'lax',
      });
    };

    res.locals.currentUser = req.session.user || null;
    res.locals.csrfToken = deriveCsrfToken(req.session);
    next();
  };
}

export function requireAuth(req, res, next) {
  if (!req.session?.user) {
    return res.redirect('/auth/discord');
  }
  next();
}
