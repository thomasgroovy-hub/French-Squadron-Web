import crypto from 'node:crypto';
import { webConfig } from '../config.js';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;

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

    req.setSession = (data) => {
      req.session = { ...data };
      const sealed = sealSession(req.session);
      res.cookie(webConfig.cookieName, sealed, sessionCookieOptions());
    };

    req.clearSession = () => {
      req.session = {};
      res.clearCookie(webConfig.cookieName, {
        path: '/',
        httpOnly: true,
        sameSite: 'lax',
      });
    };

    res.locals.currentUser = req.session.user || null;
    next();
  };
}

export function requireAuth(req, res, next) {
  if (!req.session?.user) {
    return res.redirect('/auth/discord');
  }
  next();
}
