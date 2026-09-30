import { webConfig } from '../config.js';
import { requireAuth } from './session.js';

const DENIED_MESSAGE =
  'Cette section est réservée aux membres possédant le rôle de gestion des formulaires et de la documentation.';

const ADMIN_DENIED_MESSAGE =
  'Cette vue est réservée aux membres possédant un rôle d’administration des formulaires.';

/**
 * True when the connected user carries the forms/documentation management
 * role. This role is deliberately independent from `webConfig.targetRoleId`
 * (the sanctions role): holding one never grants the other.
 */
export function hasFormsRole(memberData) {
  return Array.isArray(memberData?.roles) && memberData.roles.includes(webConfig.formsRoleId);
}

/**
 * Can this member see and answer this form?
 *
 * Three cases, in order:
 *  - no `requiredRoleId`: the form is open to every connected member;
 *  - the member holds the required role: access granted;
 *  - otherwise denied.
 *
 * The role is read from the form row and the roles from `req.memberData`, both
 * server-side, so a request cannot claim its way in. The creator and the
 * administration roles are deliberately NOT covered here: a manager must always
 * reach a form they created, even after locking it to a role they don't hold —
 * the check lives at the call site, which asks `canManageForm` first.
 */
export function meetsRequiredRole(memberData, requiredRoleId) {
  if (!requiredRoleId) return true;
  return Array.isArray(memberData?.roles) && memberData.roles.includes(requiredRoleId);
}

/** Message shown when a form is locked behind a role the member lacks. */
export const REQUIRED_ROLE_DENIED_MESSAGE =
  'Ce formulaire est réservé aux membres possédant un rôle spécifique. Si vous pensez que c’est une erreur, contactez un responsable.';

/**
 * True when the connected user carries one of the forms administration roles
 * (`webConfig.formsAdminRoleIds`). Unlike `hasFormsRole`, this is not scoped to
 * the forms the member created: it is the transversal "supervision" level of the
 * forms module, and it is the *only* source of truth for lifting an ownership
 * filter. Everything else (routes, services) asks this function — never the
 * request body, never a query parameter — so a direct API call cannot widen
 * its own scope.
 */
export function hasFormsAdminRole(memberData) {
  return Array.isArray(memberData?.roles)
    && memberData.roles.some((roleId) => webConfig.formsAdminRoleIds.includes(roleId));
}

/**
 * True when the user may use the forms module at all: the management role, or
 * one of the administration roles. The nav tabs, the write routes and the
 * responses inbox all share this single gate.
 */
export function canManageForms(memberData) {
  return hasFormsRole(memberData) || hasFormsAdminRole(memberData);
}

/**
 * Server-side gate: every forms/documentation route goes through it. Named after
 * the capability ("access to the forms module") rather than after a role, since
 * two different roles now satisfy it.
 */
export function requireFormsAccess(req, res, next) {
  // Anonymous visitors get the same Discord OAuth2 bounce as the rest of the
  // site, so a role-gated tab never renders a bare 401.
  if (!req.session?.user) return requireAuth(req, res, next);
  if (!canManageForms(req.memberData)) {
    return res.status(403).render('error', {
      title: 'Accès réservé',
      message: DENIED_MESSAGE,
    });
  }
  next();
}

/**
 * Server-side gate for the global forms overview. Stricter than
 * `requireFormsAccess`: the management role keeps seeing only its own forms, so
 * the administration roles are required here.
 */
export function requireFormsAdmin(req, res, next) {
  if (!req.session?.user) return requireAuth(req, res, next);
  if (!hasFormsAdminRole(req.memberData)) {
    return res.status(403).render('error', {
      title: 'Accès réservé',
      message: ADMIN_DENIED_MESSAGE,
    });
  }
  next();
}

/**
 * Ownership check for a single form. Reads `req.memberData` (Discord-verified)
 * and `req.session.user` (sealed cookie) only, so a request cannot claim to be
 * somebody else's creator.
 */
export function canManageForm(req, form) {
  if (!form) return false;
  if (hasFormsAdminRole(req.memberData)) return true;
  return form.creatorDiscordId === req.session?.user?.id;
}

/**
 * The single resolver turning "who is asking" into "what may they read".
 *
 * `includeAllForms` is the only value the forms services use to decide whether
 * to keep their `creator_discord_id` SQL predicate. Routes spread it into every
 * ownership-sensitive service call instead of recomputing the role check, so
 * the permission decision lives in exactly one place.
 */
export function formsOwnerScope(req) {
  const isAdmin = hasFormsAdminRole(req.memberData);
  return {
    isAdmin,
    includeAllForms: isAdmin,
    creatorDiscordId: req.session?.user?.id || null,
  };
}

/**
 * True when the connected user carries the member management role
 * (supervision tab access: permadeath, sanctions, member directory).
 */
export function hasMemberManagementRole(memberData) {
  return Array.isArray(memberData?.roles) && memberData.roles.includes(webConfig.memberManagementRoleId);
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
  adminDenied: ADMIN_DENIED_MESSAGE,
});
