import { webConfig } from '../config.js';
import { requireAuth } from './session.js';

const DENIED_MESSAGE =
  'Cette section est réservée aux membres possédant le rôle de gestion des formulaires et de la documentation.';

/**
 * True when the connected user carries the forms/documentation management
 * role. This role is deliberately independent from `webConfig.targetRoleId`
 * (the sanctions role): holding one never grants the other.
 */
export function hasFormsRole(memberData) {
  return Array.isArray(memberData?.roles) && memberData.roles.includes(webConfig.formsRoleId);
}

/** Server-side gate: every write route for forms/documentation goes through it. */
export function requireFormsRole(req, res, next) {
  // Anonymous visitors get the same Discord OAuth2 bounce as the rest of the
  // site, so a role-gated tab never renders a bare 401.
  if (!req.session?.user) return requireAuth(req, res, next);
  if (!hasFormsRole(req.memberData)) {
    return res.status(403).render('error', {
      title: 'Accès réservé',
      message: DENIED_MESSAGE,
    });
  }
  next();
}

export const formsAccessMessages = Object.freeze({
  denied: DENIED_MESSAGE,
});
