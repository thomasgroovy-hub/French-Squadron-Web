import { Router } from 'express';
import { requireAuth } from '../auth/session.js';
import { webConfig } from '../config.js';
import { webConfig as webConfigImport } from '../config.js';
import {
  fetchGuildMemberDirectory,
  fetchGuildMemberRoles,
  fetchGuildRoleNames,
  formatAccountAge,
  formatDate,
  getDiscordCreationDate,
} from '../services/discord.js';
import { getLinkedRobloxData } from '../services/roblox.js';
import { fetchMemberSanctions, createStrike, updateStrikeReason, deleteStrike, STRIKE_ERROR_MESSAGES } from '../services/sanctions.js';
import { recordStrikeEvent, STRIKE_ACTIONS } from '../services/strike-events.js';
import { fetchMemberDeaths } from '../services/deaths.js';
import { fetchAllLinkedMembers, fetchLinkedMember } from '../services/members.js';
import { getGrades, getRoleLabels } from '../config/roles.js';
import {
  hasFormsRole,
  hasMemberManagementRole,
  hasTargetRole,
  requireFormsRole,
  requireSupervisionAccess,
  requireTargetRole,
} from '../auth/guards.js';
import { createFormsRouter, createResponsesRouter } from './forms.js';
import { createDocumentationRouter } from './documentation.js';

export function createMainRouter({ pool, sitePool, fetchFn } = {}) {
  const router = Router();

  router.use(async (req, res, next) => {
    if (!req.session?.user) return next();
    try {
      req.memberData = await fetchGuildMemberRoles({ userId: req.session.user.id, fetchFn });
      res.locals.isStaff = req.memberData.hasTargetRole;
      // Member management role (supervision tab: permadeath, sanctions, member directory)
      res.locals.isMemberManagement = hasMemberManagementRole(req.memberData);
      // Comit� d'�thique: may open a member file and manage its strikes.
      res.locals.canManageStrikes = hasTargetRole(req.memberData);
      // Forms/documentation management role, independent from the sanctions one.
      res.locals.isFormManager = hasFormsRole(req.memberData);
      // Cache for Roblox data to avoid duplicate fetches per request
      req.robloxCache = new Map();
      next();
    } catch (error) {
      next(error);
    }
  });

  async function buildProfileData(req, user, memberData, { staffView = false } = {}) {
    const discordCreatedAt = getDiscordCreationDate(user.id);
    const discordInfo = {
      id: user.id,
      username: user.username,
      globalName: user.globalName || user.username,
      avatarUrl: user.avatarUrl,
      createdAt: discordCreatedAt,
      formattedCreatedAt: formatDate(discordCreatedAt),
      accountAge: formatAccountAge(discordCreatedAt),
    };
    const cacheKey = user.id;
    let roblox = req.robloxCache?.get(cacheKey);
    if (!roblox) {
      roblox = await getLinkedRobloxData(user.id, { pool, sitePool, fetchFn });
      req.robloxCache?.set(cacheKey, roblox);
    }
    const hasTargetRole = Boolean(memberData?.hasTargetRole);
    const roleNames = await fetchGuildRoleNames({ fetchFn });
    const grades = getGrades(memberData?.roles || [], roleNames);
    const sanctions = (hasTargetRole || staffView)
      ? await fetchMemberSanctions(user.id, pool)
      : null;
    return {
      discordInfo,
      memberData: memberData || { inGuild: false, roles: [], hasTargetRole: false },
      roblox,
      grades,
      primaryGrade: grades[0] || null,
      hasTargetRole,
      sanctions,
      targetRoleId: webConfig.targetRoleId,
      isStaffView: staffView,
    };
  }

  router.get('/', async (req, res) => {
    if (!req.session?.user) {
      return res.render('dashboard', {
        title: 'Accueil | Site-66',
        isConnected: false,
      });
    }
    try {
      const user = req.session.user;
      const roblox = await getLinkedRobloxData(user.id, { pool, sitePool, fetchFn });
      return res.render('dashboard', {
        title: 'Accueil | Site-66',
        isConnected: true,
        roblox,
      });
    } catch (error) {
      console.error('[WebRoutes] Error rendering dashboard:', error);
      return res.status(500).render('error', {
        title: 'Erreur lors du chargement de l’accueil',
        message: 'Impossible de charger les informations du compte. Veuillez réessayer plus tard.',
      });
    }
  });

  router.get('/profile', requireAuth, async (req, res) => {
    try {
      const profile = await buildProfileData(req, req.session.user, req.memberData);
      res.render('profile-detail', {
        title: 'Mon Profil | Site-66',
        ...profile,
      });
    } catch (error) {
      console.error('[WebRoutes] Error rendering profile:', error);
      res.status(500).render('error', {
        title: 'Erreur lors du chargement du profil',
        message: 'Impossible de charger l’ensemble des informations du profil. Veuillez réessayer plus tard.',
      });
    }
  });

  router.get('/terms', (req, res) => {
    res.render('terms', { title: 'Conditions Générales d’Utilisation' });
  });

  router.get('/privacy', (req, res) => {
    res.render('privacy', { title: 'Politique de Confidentialité' });
  });

  // « Candidatures » is open to any connected member; « Réponses » and the
  // documentation manager require the forms role.
  router.use('/candidatures', createFormsRouter({ pool, fetchFn }));
  router.use('/reponses', createResponsesRouter({ pool, fetchFn }));
  if (webConfig.documentationEnabled) {
    router.use('/documentation', createDocumentationRouter({ pool }));
  } else {
    router.get('/documentation', requireAuth, (req, res) => {
      res.status(503).render('error', {
        title: 'Documentation indisponible',
        message: 'Le module de documentation est temporairement désactivé. Merci de votre patience.',
      });
    });
  }

  // A member file is reachable by the supervision role and by the comit�
  // d'�thique, which needs it to manage strikes. The tab itself is rendered
  // for either role.
  router.use('/members', requireAuth, requireSupervisionAccess);

  router.get('/members', async (req, res) => {
    try {
      const search = typeof req.query.q === 'string' ? req.query.q.trim().slice(0, 80) : '';
      // One roster request replaces the previous two per-member lookups per
      // linked account, which is what triggered Discord's 429 rate limiting.
      const memberDirectory = await fetchGuildMemberDirectory({ fetchFn });
      const users = await fetchAllLinkedMembers(search, { pool, sitePool, fetchFn, memberDirectory });
      let nextIndex = 0;
      await Promise.all(Array.from({ length: Math.min(6, users.length) }, async () => {
        while (nextIndex < users.length) {
          const userIndex = nextIndex;
          nextIndex += 1;
          const member = users[userIndex];
          const known = memberDirectory?.get(member.discord_user_id);
          const roleData = known
            ? { roles: known.roles }
            : await fetchGuildMemberRoles({ userId: member.discord_user_id, fetchFn });
          member.grades = getRoleLabels(roleData.roles);
        }
      }));
      res.render('members', {
        title: 'Supervision | Site-66',
        users,
        search,
      });
    } catch (error) {
      console.error('[WebRoutes] Error loading member directory:', error);
      res.status(500).render('error', {
        title: 'Erreur lors du chargement des membres',
        message: 'Impossible de charger la liste des membres. Veuillez réessayer plus tard.',
      });
    }
  });

  router.get('/members/:discordUserId', async (req, res) => {
    try {
      const member = await fetchLinkedMember(req.params.discordUserId, { pool, sitePool, fetchFn });
      if (!member) {
        return res.status(404).render('error', {
          title: 'Membre introuvable',
          message: 'Aucun lien Roblox-Discord trouvé pour ce compte.',
        });
      }
      const targetUser = {
        id: member.discord_user_id,
        username: member.discord_username,
        globalName: member.global_name,
        avatarUrl: member.avatar_url,
      };
      const roleData = await fetchGuildMemberRoles({ userId: targetUser.id, fetchFn });
      const profile = await buildProfileData(req, targetUser, roleData, { staffView: true });
      const deaths = await fetchMemberDeaths(targetUser.id, pool, { isStaff: true });
      res.render('profile-detail', {
        title: `${targetUser.globalName} | Supervision`,
        ...profile,
        deaths,
        isStaffView: true,
        isReadOnly: true,
        canManageStrikes: hasTargetRole(req.memberData),
        strikeTarget: targetUser,
      });
    } catch (error) {
      console.error('[WebRoutes] Error rendering supervised profile:', error);
      res.status(500).render('error', {
        title: 'Erreur lors du chargement du profil',
        message: 'Impossible de charger la fiche de ce membre. Veuillez réessayer plus tard.',
      });
    }
  });

  // -- Strike management (comit� d'�thique) ------------------------------
  // Writes straight into the `strikes` table shared with the Discord bot, so
  // a change here is immediately visible to the bot's moderation commands.
  // The page is re-rendered rather than redirected so the reason text survives
  // a validation failure.
  async function handleStrikeAction(req, res, action) {
    const target = req.params.discordUserId;
    const view = {
      title: 'Sanctions | Site-66',
      error: null,
      notice: null,
    };

    const result = await action(target);
    if (!result.ok) {
      view.error = STRIKE_ERROR_MESSAGES[result.error] || STRIKE_ERROR_MESSAGES['insert-failed'];
      return res.status(result.error === 'not-found' ? 404 : 400).render('error', {
        ...view,
        title: 'Action impossible',
        message: view.error,
      });
    }
    return res.redirect(`/members/${target}#sanctions`);
  }

  /**
   * Resolves the display names the Discord relay shows. The acting user always
   * comes from the sealed session, never from the request body, so a staff
   * member cannot forge who performed an action.
   */
  async function resolveStrikeAuditNames(req) {
    const actorName = req.session.user.globalName || req.session.user.username || null;
    let targetName = null;
    try {
      const member = await fetchLinkedMember(req.params.discordUserId, { pool, sitePool, fetchFn });
      targetName = member?.global_name || member?.discord_username || null;
    } catch {
      // A missing mirror row only costs the log its pretty name.
    }
    return { actorName, targetName };
  }

  router.post(
    '/members/:discordUserId/strikes',
    requireTargetRole,
    async (req, res) => {
      const target = req.params.discordUserId;
      return handleStrikeAction(req, res, async () => {
        const result = await createStrike({
          discordUserId: target,
          moderatorId: req.session.user.id,
          reason: req.body?.reason,
        }, pool);
        if (!result.ok) return result;

        const names = await resolveStrikeAuditNames(req);
        await recordStrikeEvent({
          strikeId: result.id,
          action: STRIKE_ACTIONS.CREATED,
          targetDiscordId: target,
          targetName: names.targetName,
          actorDiscordId: req.session.user.id,
          actorName: names.actorName,
          newReason: req.body?.reason,
        }, pool);
        return result;
      });
    },
  );

  router.post(
    '/members/:discordUserId/strikes/:strikeId/edit',
    requireTargetRole,
    async (req, res) => {
      const target = req.params.discordUserId;
      return handleStrikeAction(req, res, async () => {
        const result = await updateStrikeReason({
          strikeId: req.params.strikeId,
          reason: req.body?.reason,
          discordUserId: target,
        }, pool);
        if (!result.ok) return result;

        const names = await resolveStrikeAuditNames(req);
        await recordStrikeEvent({
          strikeId: result.id,
          action: STRIKE_ACTIONS.UPDATED,
          targetDiscordId: target,
          targetName: names.targetName,
          actorDiscordId: req.session.user.id,
          actorName: names.actorName,
          previousReason: result.previousReason,
          newReason: result.newReason,
        }, pool);
        return result;
      });
    },
  );

  router.post(
    '/members/:discordUserId/strikes/:strikeId/remove',
    requireTargetRole,
    async (req, res) => {
      const target = req.params.discordUserId;
      return handleStrikeAction(req, res, async () => {
        const result = await deleteStrike({
          strikeId: req.params.strikeId,
          discordUserId: target,
        }, pool);
        if (!result.ok) return result;

        const names = await resolveStrikeAuditNames(req);
        await recordStrikeEvent({
          strikeId: result.id,
          action: STRIKE_ACTIONS.DELETED,
          targetDiscordId: target,
          targetName: names.targetName,
          actorDiscordId: req.session.user.id,
          actorName: names.actorName,
          previousReason: result.previousReason,
        }, pool);
        return result;
      });
    },
  );

  return router;
}


