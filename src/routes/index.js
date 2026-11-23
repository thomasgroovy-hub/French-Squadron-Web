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
  fetchBotGuilds,
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

const BOT_ADMIN_PATH = '/administration/bot';
const BOT_GENERAL_SCOPE_ID = 'general';
const MODERATION_PAGE_SIZE = 50;
const MODERATION_SOURCE_LIMIT = 2000;
const MODERATION_TYPE_FILTERS = new Set(['all', 'warn', 'ban', 'case']);
const MODERATION_TABLES = Object.freeze(['strikes', 'moderation_cases', 'moderation_bans']);
const moderationColumnCache = new WeakMap();

const MODERATION_SOURCE_LABELS = Object.freeze({
  strikes: 'les avertissements',
  moderation_cases: 'les cas de modération',
  moderation_bans: 'les bannissements',
});

const MODERATION_CASE_TYPES = Object.freeze({
  exclusion: { label: 'Exclusion', severity: 'warning' },
  bannissement: { label: 'Bannissement', severity: 'danger' },
  expulsion: { label: 'Expulsion', severity: 'danger' },
});

function firstQueryString(value) {
  if (typeof value === 'string') return value;
  if (Array.isArray(value) && typeof value[0] === 'string') return value[0];
  return '';
}

function normalizeModerationTypeFilter(value) {
  const normalized = firstQueryString(value).trim().toLowerCase();
  return MODERATION_TYPE_FILTERS.has(normalized) ? normalized : 'all';
}

function normalizeModerationPage(value) {
  const page = Number.parseInt(firstQueryString(value), 10);
  return Number.isSafeInteger(page) && page > 0 ? page : 1;
}

function normalizeModerationSearch(value) {
  return firstQueryString(value).trim().slice(0, 80);
}

function describeModerationDate(value) {
  if (!value) return { value: null, label: '—', sortTime: 0 };
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return { value: null, label: '—', sortTime: 0 };
  return { value: date, label: formatDate(date), sortTime: date.getTime() };
}

function generalBotScope() {
  return {
    id: BOT_GENERAL_SCOPE_ID,
    kind: 'general',
    name: 'Journaux généraux',
    guildId: null,
    guildName: null,
  };
}

function guildBotScope(guild) {
  return {
    id: guild.id,
    kind: 'server',
    name: guild.name,
    guildId: guild.id,
    guildName: guild.name,
  };
}

function resolveBotScope(requestedId, guilds, configuredGuildId) {
  const requested = firstQueryString(requestedId).trim();
  if (!requested) {
    const configured = guilds.find((guild) => guild.id === configuredGuildId);
    const fallback = configured || guilds[0];
    return { scope: fallback ? guildBotScope(fallback) : generalBotScope() };
  }
  if (requested === BOT_GENERAL_SCOPE_ID) return { scope: generalBotScope() };
  const guild = guilds.find((entry) => entry.id === requested);
  if (!guild) return { error: 'Ce serveur n’est pas accessible au bot.', status: 404 };
  return { scope: guildBotScope(guild) };
}

async function loadBotGuilds(fetchFn, config) {
  return fetchBotGuilds({
    botToken: config.discordToken ?? webConfig.discordToken,
    fetchFn,
    guildId: config.guildId ?? webConfig.guildId,
  });
}

async function resolveWebStrikeGuild(fetchFn, config) {
  const guildId = config.guildId ?? webConfig.guildId;
  if (!guildId) return {};
  const guildResult = await loadBotGuilds(fetchFn, config);
  const guild = guildResult.guilds.find((entry) => entry.id === guildId);
  return { guildId, guildName: guild?.name ?? null };
}

async function getModerationColumns(dbPool, table) {
  let byPool = moderationColumnCache.get(dbPool);
  if (!byPool) {
    byPool = new Map();
    moderationColumnCache.set(dbPool, byPool);
  }
  if (byPool.has(table)) return byPool.get(table);

  const columns = new Set();
  try {
    const [rows] = await dbPool.execute(`SHOW COLUMNS FROM \`${table}\``);
    for (const row of Array.isArray(rows) ? rows : []) {
      const name = row.Field ?? row.field ?? row.COLUMN_NAME ?? row.column_name;
      if (typeof name === 'string') columns.add(name);
    }
  } catch (error) {
    console.warn(`[WebRoutes] Could not inspect columns of ${table}:`, error.message);
  }
  byPool.set(table, columns);
  return columns;
}

function buildModerationQuery(table, columns, scope) {
  const hasGuildId = columns.has('guild_id');
  const hasGuildName = columns.has('guild_name');
  if (scope.kind === 'server' && !hasGuildId && !hasGuildName) return null;

  const guildIdExpression = hasGuildId ? '`guild_id` AS guild_id' : 'NULL AS guild_id';
  const guildNameExpression = hasGuildName ? '`guild_name` AS guild_name' : 'NULL AS guild_name';
  let baseColumns;
  let dateColumn;
  if (table === 'strikes') {
    baseColumns = 'discord_id, moderator_discord_id, raison, created_at';
    dateColumn = 'created_at';
  } else if (table === 'moderation_cases') {
    baseColumns = 'discord_id, type, moderator_discord_id, raison, created_at';
    dateColumn = 'created_at';
  } else {
    baseColumns = 'discord_id, banned_at';
    dateColumn = 'banned_at';
  }

  const conditions = [];
  const params = [];
  if (scope.kind === 'server') {
    if (hasGuildId && /^[0-9]{17,20}$/.test(scope.guildId || '')) {
      conditions.push('`guild_id` = ?');
      params.push(scope.guildId);
    } else if (hasGuildName) {
      conditions.push('`guild_name` = ?');
      params.push(scope.guildName);
    } else if (hasGuildId) {
      return null;
    }
  } else {
    if (hasGuildId) conditions.push('(`guild_id` IS NULL OR `guild_id` = \'\')');
    if (hasGuildName) conditions.push('(`guild_name` IS NULL OR `guild_name` = \'\')');
  }

  const where = conditions.length ? ` WHERE ${conditions.join(' AND ')}` : '';
  const sql = `SELECT ${baseColumns}, ${guildIdExpression}, ${guildNameExpression} FROM \`${table}\`${where} ORDER BY \`${dateColumn}\` DESC LIMIT ?`;
  return { sql, params: [...params, MODERATION_SOURCE_LIMIT] };
}

async function queryModerationRows(dbPool, table, scope) {
  const columns = await getModerationColumns(dbPool, table);
  const query = buildModerationQuery(table, columns, scope);
  if (!query) return { rows: [], available: false };
  const [rows] = await dbPool.execute(query.sql, query.params);
  return { rows: Array.isArray(rows) ? rows : [], available: true };
}

async function loadModerationLogEntries(dbPool, scope) {
  const entries = [];
  const failedSources = [];
  const truncatedSources = [];

  if (!dbPool) {
    return { entries, failedSources: [...MODERATION_TABLES], truncatedSources };
  }

  for (const table of MODERATION_TABLES) {
    try {
      const { rows, available } = await queryModerationRows(dbPool, table, scope);
      if (!available) continue;
      if (rows.length >= MODERATION_SOURCE_LIMIT) truncatedSources.push(table);
      for (const row of rows) {
        const date = describeModerationDate(table === 'moderation_bans' ? row.banned_at : row.created_at);
        const rowGuildId = row.guild_id ? String(row.guild_id) : null;
        const rowGuildName = typeof row.guild_name === 'string' && row.guild_name ? row.guild_name : null;
        let payload;
        if (table === 'strikes') {
          payload = {
            actionType: 'warn',
            actionLabel: 'Avertissement',
            severity: 'warning',
            targetDiscordId: row.discord_id,
            moderatorDiscordId: row.moderator_discord_id || null,
            reason: row.raison || null,
          };
        } else if (table === 'moderation_cases') {
          const meta = MODERATION_CASE_TYPES[row.type] || { label: row.type || 'Cas de modération', severity: 'warning' };
          payload = {
            actionType: 'case',
            actionLabel: meta.label,
            severity: meta.severity,
            targetDiscordId: row.discord_id,
            moderatorDiscordId: row.moderator_discord_id || null,
            reason: row.raison || null,
          };
        } else {
          payload = {
            actionType: 'ban',
            actionLabel: 'Bannissement',
            severity: 'danger',
            targetDiscordId: row.discord_id,
            moderatorDiscordId: null,
            reason: null,
          };
        }
        entries.push({
          ...payload,
          guildId: rowGuildId || (scope.kind === 'server' ? scope.guildId : null),
          guildName: rowGuildName || (scope.kind === 'server' ? scope.guildName : null),
          createdAt: date.value,
          formattedDate: date.label,
          sortTime: date.sortTime,
          source: table,
        });
      }
    } catch (error) {
      console.error(`[WebRoutes] Error querying ${table} for the bot moderation log:`, error.message);
      failedSources.push(table);
    }
  }

  return { entries, failedSources, truncatedSources };
}

function matchesModerationSearch(entry, searchTerm) {
  if (!searchTerm) return true;
  return [entry.actionLabel, entry.targetDiscordId, entry.moderatorDiscordId, entry.reason, entry.guildName]
    .some((value) => typeof value === 'string' && value.toLocaleLowerCase('fr').includes(searchTerm));
}

async function buildBotLogData(dbPool, scope, query) {
  const typeFilter = normalizeModerationTypeFilter(query.type);
  const search = normalizeModerationSearch(query.q);
  const searchTerm = search.toLocaleLowerCase('fr');
  const { entries, failedSources, truncatedSources } = await loadModerationLogEntries(dbPool, scope);

  const matching = entries
    .filter((entry) => typeFilter === 'all' || entry.actionType === typeFilter)
    .filter((entry) => matchesModerationSearch(entry, searchTerm))
    .sort((a, b) => b.sortTime - a.sortTime);

  const total = matching.length;
  const totalPages = Math.max(1, Math.ceil(total / MODERATION_PAGE_SIZE));
  const page = Math.min(normalizeModerationPage(query.page), totalPages);
  const startIndex = (page - 1) * MODERATION_PAGE_SIZE;

  return {
    entries: matching.slice(startIndex, startIndex + MODERATION_PAGE_SIZE),
    typeFilter,
    search,
    page,
    totalPages,
    total,
    rangeStart: total ? startIndex + 1 : 0,
    rangeEnd: Math.min(startIndex + MODERATION_PAGE_SIZE, total),
    failedSources,
    truncatedSources,
    sourceLimit: MODERATION_SOURCE_LIMIT,
  };
}

function buildBotLogUrl(scopeId, typeFilter, search, page) {
  const params = new URLSearchParams();
  params.set('serveur', scopeId);
  if (typeFilter !== 'all') params.set('type', typeFilter);
  if (search) params.set('q', search);
  if (page > 1) params.set('page', String(page));
  return `${BOT_ADMIN_PATH}?${params.toString()}`;
}

function resolveDbPool(pool) {
  if (pool) return pool;
  try {
    return getDatabasePool();
  } catch {
    return null;
  }
}

export function createMainRouter({ pool, sitePool, fetchFn, config = webConfig } = {}) {
  const router = Router();

  router.use(async (req, res, next) => {
    if (!req.session?.user) return next();
    try {
      req.memberData = await fetchGuildMemberRoles({ userId: req.session.user.id, fetchFn });
      res.locals.isStaff = hasTargetRole(req.memberData);
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
    const targetAccess = hasTargetRole(memberData);
    const roleNames = await fetchGuildRoleNames({ fetchFn });
    const grades = getGrades(memberData?.roles || [], roleNames);
    const sanctions = (targetAccess || staffView)
      ? await fetchMemberSanctions(user.id, pool)
      : null;
    return {
      discordInfo,
      memberData: memberData || { inGuild: false, roles: [], hasTargetRole: false },
      roblox,
      grades,
      primaryGrade: grades[0] || null,
      hasTargetRole: targetAccess,
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
  router.use('/candidatures', createFormsRouter({ pool, sitePool, fetchFn, config }));
  router.use('/reponses', createResponsesRouter({ pool, sitePool, fetchFn, config }));
  // Supervision transverse des formulaires. Son propre routeur porte la porte
  // `requireFormsAdmin` : le rôle de gestion « sur ses propres formulaires »
  // n'y entre pas, et n'y gagne donc aucun droit nouveau.
  router.use('/administration', createFormsAdminRouter({ pool, fetchFn }));
  router.use('/documentation', createDocumentationRouter());

  router.get(`${BOT_ADMIN_PATH}/api/serveurs`, requireAuth, requireBotAdminRole, async (req, res) => {
    const guildResult = await loadBotGuilds(fetchFn, config);
    if (!guildResult.ok) {
      return res.status(guildResult.status).json({ ok: false, error: guildResult.error });
    }
    return res.json({
      ok: true,
      guilds: guildResult.guilds,
      configuredGuildId: config.guildId ?? webConfig.guildId,
      generalScope: generalBotScope(),
    });
  });

  router.get(`${BOT_ADMIN_PATH}/api/journaux`, requireAuth, requireBotAdminRole, async (req, res) => {
    const guildResult = await loadBotGuilds(fetchFn, config);
    const resolved = resolveBotScope(req.query.serveur, guildResult.guilds, config.guildId ?? webConfig.guildId);
    if (!resolved.scope) {
      return res.status(resolved.status).json({ ok: false, error: resolved.error });
    }

    const logData = await buildBotLogData(resolveDbPool(pool), resolved.scope, req.query);
    return res.json({
      ok: true,
      scope: resolved.scope,
      sourceLabels: MODERATION_SOURCE_LABELS,
      guildError: guildResult.ok ? null : guildResult.error,
      ...logData,
    });
  });

  router.get(BOT_ADMIN_PATH, requireAuth, requireBotAdminRole, async (req, res) => {
    const guildResult = await loadBotGuilds(fetchFn, config);
    const resolved = resolveBotScope(req.query.serveur, guildResult.guilds, config.guildId ?? webConfig.guildId);
    if (!resolved.scope) {
      return res.status(resolved.status).render('error', {
        title: 'Serveur introuvable',
        message: resolved.error,
      });
    }

    const logData = await buildBotLogData(resolveDbPool(pool), resolved.scope, req.query);
    res.render('bot-admin', {
      title: 'Administration du bot | Site-66',
      guilds: guildResult.guilds,
      configuredGuildId: config.guildId ?? webConfig.guildId,
      selectedScope: resolved.scope,
      guildError: guildResult.ok ? null : guildResult.error,
      sourceLabels: MODERATION_SOURCE_LABELS,
      buildBotLogUrl,
      ...logData,
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
        const guild = await resolveWebStrikeGuild(fetchFn, config);
        const result = await createStrike({
          discordUserId: target,
          moderatorId: req.session.user.id,
          reason: req.body?.reason,
          ...guild,
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

