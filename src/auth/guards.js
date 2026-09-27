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

/**
 * True when the connected user carries the member management role
 * (supervision tab access: permadeath, sanctions, member directory).
 */
export function hasMemberManagementRole(memberData) {
  return Array.isArray(memberData?.roles) && memberData.roles.includes(webConfig.memberManagementRoleId);
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

/** Server-side gate: member management routes (supervision tab). */
export function requireMemberManagementRole(req, res, next) {
  if (!req.session?.user) return requireAuth(req, res, next);
  if (!hasMemberManagementRole(req.memberData)) {
    return res.status(403).render('error', {
      title: 'Accès réservé',
      message: 'Cette section est réservée aux membres de la supervision.',
    });
  }
  next();
}

/**
 * True when the connected user carries the "comité d'éthique" role: the one
 * that unlocks the sanctions panel on a member file. This is
 * `webConfig.targetRoleId`, deliberately independent from the member
 * management (supervision) and forms roles.
 */
export function hasTargetRole(memberData) {
  if (typeof memberData?.hasTargetRole === 'boolean') return memberData.hasTargetRole;
  return Array.isArray(memberData?.roles) && memberData.roles.includes(webConfig.targetRoleId);
}

/**
 * True when the connected user may open a member file: either the comité
 * d'éthique (sanctions panel) or the member management role (supervision tab).
 */
export function hasSupervisionAccess(memberData) {
  return hasTargetRole(memberData) || hasMemberManagementRole(memberData);
}

const ETHICS_DENIED_MESSAGE =
  'Cette action est réservée aux membres du comité d’éthique.';

/** Server-side gate: strike management (add, edit, remove). */
export function requireTargetRole(req, res, next) {
  if (!req.session?.user) return requireAuth(req, res, next);
  if (!hasTargetRole(req.memberData)) {
    return res.status(403).render('error', {
      title: 'Accès réservé',
      message: ETHICS_DENIED_MESSAGE,
    });
  }
  next();
}

/**
 * Server-side gate: member files. The comité d'éthique needs to reach a file
 * to manage its strikes, so it is accepted here alongside the supervision
 * role that owns the tab.
 */
export function requireSupervisionAccess(req, res, next) {
  if (!req.session?.user) return requireAuth(req, res, next);
  if (!hasSupervisionAccess(req.memberData)) {
    return res.status(403).render('error', {
      title: 'Accès réservé',
      message: 'Cette section est réservée aux membres de la supervision.',
    });
  }
  next();
}

export const formsAccessMessages = Object.freeze({
  denied: DENIED_MESSAGE,
});
