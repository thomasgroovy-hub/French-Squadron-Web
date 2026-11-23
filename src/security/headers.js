import crypto from 'node:crypto';
import { webConfig } from '../config.js';

/**
 * Security headers, applied to every response before anything is rendered.
 * The CSP carries a per-request nonce so the handful of inline scripts can
 * stay inline without `'unsafe-eval'` or blanket `'unsafe-inline'` for scripts.
 * Styles still allow `'unsafe-inline'`: the whole UI relies on inline
 * `style=` attributes, and style injection cannot execute script under CSP2.
 */
export function securityHeaders({ isProduction = webConfig.isProduction } = {}) {
  return function setSecurityHeaders(req, res, next) {
    const nonce = crypto.randomBytes(16).toString('base64');
    res.locals.cspNonce = nonce;

    const directives = [
      "default-src 'self'",
      `script-src 'self' 'nonce-${nonce}'`,
      "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
      "img-src 'self' https: data:",
      "font-src 'self' https://fonts.gstatic.com",
      "connect-src 'self'",
      "object-src 'none'",
      "base-uri 'self'",
      "form-action 'self'",
      "frame-ancestors 'none'",
      ...(isProduction ? ['upgrade-insecure-requests'] : []),
    ];
    res.setHeader('Content-Security-Policy', directives.join('; '));
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=()');
    res.setHeader('X-Permitted-Cross-Domain-Policies', 'none');
    if (isProduction) {
      res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    }
    // Pages carry session-scoped personal data: no shared caching. The static
    // handler overwrites this for assets it serves itself.
    res.setHeader('Cache-Control', 'no-store');
    next();
  };
}
