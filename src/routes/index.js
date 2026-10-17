import { Router } from 'express';
import { requireAuth } from '../auth/session.js';
import { webConfig } from '../config.js';
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
  canManageForms,
  hasFormsAdminRole,
  hasMemberManagementRole,
  hasTargetRole,
  requireSupervisionAccess,
  requireTargetRole,
} from '../auth/guards.js';
import { createFormsAdminRouter, createFormsRouter, createResponsesRouter } from './forms.js';
import { createDocumentationRouter } from './documentation.js';
import { hasBotAdminRole, requireBotAdminRole } from '../auth/guards.js';
import { getDatabasePool } from '../database.js';

// -- Journal de modération (page /administration/bot) -----------------------
// Les trois tables sont celles écrites par le bot Discord
// (`french-squadron-utils/src/moderation.js`) : mêmes noms, mêmes colonnes.
const MODERATION_PAGE_SIZE = 50;

/**
 * Aucune des trois tables n'est indexée sur sa colonne de date : un `LIMIT`
 * n'évite donc pas le tri, il borne seulement le volume transféré. Le plafond
 * reste généreux pour que la pagination courante soit exacte, et la vue prévient
 * quand une table est plus fournie — plutôt que de faire croire que le total
 * affiché est exhaustif.
 */
const MODERATION_SOURCE_LIMIT = 2000;

const MODERATION_TYPE_FILTERS = new Set(['all', 'warn', 'ban', 'case']);

/** Types réellement écrits par le bot, avec leur libellé et leur gravité. */
const MODERATION_CASE_TYPES = Object.freeze({
  exclusion: { label: 'Exclusion', severity: 'warning' },
  bannissement: { label: 'Bannissement', severity: 'danger' },
  expulsion: { label: 'Expulsion', severity: 'danger' },
});

function normalizeModerationTypeFilter(value) {
  return MODERATION_TYPE_FILTERS.has(value) ? value : 'all';
}

/** Toute valeur non entière strictement positive retombe sur la première page. */
function normalizeModerationPage(value) {
  const page = Number.parseInt(value, 10);
  return Number.isSafeInteger(page) && page > 0 ? page : 1;
}

/**
 * Une date absente ou illisible ne doit ni faire échouer le rendu ni se placer
 * arbitrairement au milieu de la liste : elle reçoit un libellé vide (`—`) et
 * remonte en fin de tri.
 */
function describeModerationDate(value) {
  if (!value) return { value: null, label: '—', sortTime: 0 };
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return { value: null, label: '—', sortTime: 0 };
  return { value: date, label: formatDate(date), sortTime: date.getTime() };
}

/**
 * Lit les trois tables de modération et les ramène dans une forme unique,
 * prête à être filtrée puis paginée en mémoire.
 *
 * Chaque table est interrogeée isolément : une table absente ou en erreur est
 * signalée dans `failedSources` et n'annule pas les enregistrements que les
 * deux autres ont effectivement renvoyés. Un échec n'est jamais présenté comme
 * une table vide.
 */
async function loadModerationLogEntries(dbPool) {
  const entries = [];
  const failedSources = [];
  const truncatedSources = [];

  if (!dbPool) {
    return { entries, failedSources: ['strikes', 'moderation_cases', 'moderation_bans'], truncatedSources };
  }

  // A. Avertissements — table `strikes`.
  try {
    const [rows] = await dbPool.execute(
      `SELECT discord_id, moderator_discord_id, raison, created_at
       FROM strikes
       ORDER BY created_at DESC
       LIMIT ?`,
      [MODERATION_SOURCE_LIMIT],
    );
    const list = Array.isArray(rows) ? rows : [];
    if (list.length >= MODERATION_SOURCE_LIMIT) truncatedSources.push('strikes');
    for (const row of list) {
      const date = describeModerationDate(row.created_at);
      entries.push({
        actionType: 'warn',
        actionLabel: 'Avertissement',
        severity: 'warning',
        targetDiscordId: row.discord_id,
        moderatorDiscordId: row.moderator_discord_id || null,
        reason: row.raison || null,
        guildName: null,
        createdAt: date.value,
        formattedDate: date.label,
        sortTime: date.sortTime,
        source: 'strikes',
      });
    }
  } catch (error) {
    console.error('[WebRoutes] Error querying strikes for the bot moderation log:', error.message);
    failedSources.push('strikes');
  }

  // B. Cas de modération — table `moderation_cases`. Le bot y écrit
  // `exclusion`, `bannissement` et `expulsion` ; un type inconnu est affiché
  // tel quel plutôt que d'être assimilé à une sanction existante.
  try {
    const [rows] = await dbPool.execute(
      `SELECT discord_id, type, moderator_discord_id, raison, created_at
       FROM moderation_cases
       ORDER BY created_at DESC
       LIMIT ?`,
      [MODERATION_SOURCE_LIMIT],
    );
    const list = Array.isArray(rows) ? rows : [];
    if (list.length >= MODERATION_SOURCE_LIMIT) truncatedSources.push('moderation_cases');
    for (const row of list) {
      const meta = MODERATION_CASE_TYPES[row.type] || { label: row.type || 'Cas de modération', severity: 'warning' };
      const date = describeModerationDate(row.created_at);
      entries.push({
        actionType: 'case',
        actionLabel: meta.label,
        severity: meta.severity,
        targetDiscordId: row.discord_id,
        moderatorDiscordId: row.moderator_discord_id || null,
        reason: row.raison || null,
        guildName: null,
        createdAt: date.value,
        formattedDate: date.label,
        sortTime: date.sortTime,
        source: 'moderation_cases',
      });
    }
  } catch (error) {
    console.error('[WebRoutes] Error querying moderation_cases for the bot moderation log:', error.message);
    failedSources.push('moderation_cases');
  }

  // C. Bannissements globaux — table `moderation_bans`. Elle ne conserve ni
  // modérateur ni raison : ces informations sont affichées vides plutôt
  // qu'estimées à partir d'une autre source.
  try {
    const [rows] = await dbPool.execute(
      `SELECT discord_id, guild_name, banned_at
       FROM moderation_bans
       ORDER BY banned_at DESC
       LIMIT ?`,
      [MODERATION_SOURCE_LIMIT],
    );
    const list = Array.isArray(rows) ? rows : [];
    if (list.length >= MODERATION_SOURCE_LIMIT) truncatedSources.push('moderation_bans');
    for (const row of list) {
      const date = describeModerationDate(row.banned_at);
      entries.push({
        actionType: 'ban',
        actionLabel: 'Bannissement',
        severity: 'danger',
        targetDiscordId: row.discord_id,
        moderatorDiscordId: null,
        reason: null,
        guildName: row.guild_name || null,
        createdAt: date.value,
        formattedDate: date.label,
        sortTime: date.sortTime,
        source: 'moderation_bans',
      });
    }
  } catch (error) {
    console.error('[WebRoutes] Error querying moderation_bans for the bot moderation log:', error.message);
    failedSources.push('moderation_bans');
  }

  return { entries, failedSources, truncatedSources };
}

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
      // The administration roles also reach the module, but across every form,
      // hence the separate local for the transversal views.
      res.locals.isFormManager = canManageForms(req.memberData);
      res.locals.isFormsAdmin = hasFormsAdminRole(req.memberData);
      res.locals.isBotAdmin = hasBotAdminRole(req.memberData);
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

  // « Candidatures » is open to any connected member; « Réponses » requires the
  // forms role. /documentation is public and static: no pool, no guard, no
  // feature flag. It used to sit behind WEB_DOCUMENTATION_ENABLED, which
  // replaced the whole page with a 503 "module désactivé" page — that flag
  // existed for the old MySQL-backed editor, which no longer exists.
  router.use('/candidatures', createFormsRouter({ pool, fetchFn }));
  router.use('/reponses', createResponsesRouter({ pool, fetchFn }));
  // Supervision transverse des formulaires. Son propre routeur porte la porte
  // `requireFormsAdmin` : le rôle de gestion « sur ses propres formulaires »
  // n'y entre pas, et n'y gagne donc aucun droit nouveau.
  router.use('/administration', createFormsAdminRouter({ pool, fetchFn }));
  router.use('/documentation', createDocumentationRouter());

  // Le journal de modération est réservé à l'administration du bot. `pool` est
  // le pool principal obtenu par `server.js` via `getDatabasePool()` : la page
  // le partage avec le reste du site, elle n'ouvre aucune connexion propre.
  router.get('/administration/bot', requireAuth, requireBotAdminRole, async (req, res) => {
    let dbPool = pool;
    if (!dbPool) {
      try {
        dbPool = getDatabasePool();
      } catch {
        dbPool = null;
      }
    }

    // `?type=` et `?page=` sont normalisés côté serveur : une valeur inconnue
    // retombe sur le filtre par défaut et une page malformée sur la première.
    const typeFilter = normalizeModerationTypeFilter(
      typeof req.query.type === 'string' ? req.query.type.trim().toLowerCase() : '',
    );

    const { entries, failedSources, truncatedSources } = await loadModerationLogEntries(dbPool);

    // Le filtre s'applique AVANT la pagination, sinon le compteur et les liens
    // « page suivante » décriraient une autre liste que celle qui est affichée.
    const matching = typeFilter === 'all'
      ? entries
      : entries.filter((entry) => entry.actionType === typeFilter);

    // Du plus récent au plus ancien. Une date manquante remonte en fin de liste
    // sans jamais perturber l'ordre des autres enregistrements.
    matching.sort((a, b) => b.sortTime - a.sortTime);

    const total = matching.length;
    const totalPages = Math.max(1, Math.ceil(total / MODERATION_PAGE_SIZE));
    // Hors bornes : on se cale sur la dernière page plutôt que d'afficher une
    // page vide dont la navigation serait fausse.
    const page = Math.min(normalizeModerationPage(req.query.page), totalPages);
    const startIndex = (page - 1) * MODERATION_PAGE_SIZE;

    res.render('bot-admin', {
      title: 'Administration du bot | Site-66',
      entries: matching.slice(startIndex, startIndex + MODERATION_PAGE_SIZE),
      typeFilter,
      page,
      totalPages,
      total,
      rangeStart: total ? startIndex + 1 : 0,
      rangeEnd: Math.min(startIndex + MODERATION_PAGE_SIZE, total),
      failedSources,
      truncatedSources,
      sourceLimit: MODERATION_SOURCE_LIMIT,
    });
  });

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


