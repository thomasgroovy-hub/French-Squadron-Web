import { Router } from 'express';
import { requireAuth } from '../auth/session.js';
import { webConfig } from '../config.js';
import {
  fetchGuildMemberRoles,
  fetchGuildRoleNames,
  formatAccountAge,
  formatDate,
  getDiscordCreationDate,
} from '../services/discord.js';
import { getLinkedRobloxData } from '../services/roblox.js';
import { fetchMemberSanctions } from '../services/sanctions.js';
import { fetchSiteUser, fetchSiteUsers } from '../services/members.js';
import { getGrades, getRoleLabels } from '../config/roles.js';
import { hasFormsRole } from '../auth/guards.js';
import { createFormsRouter, createResponsesRouter } from './forms.js';
import { createDocumentationRouter } from './documentation.js';

export function createMainRouter({ pool, fetchFn } = {}) {
  const router = Router();

  router.use(async (req, res, next) => {
    if (!req.session?.user) return next();
    try {
      req.memberData = await fetchGuildMemberRoles({ userId: req.session.user.id, fetchFn });
      res.locals.isStaff = req.memberData.hasTargetRole;
      // Forms/documentation management role, independent from the sanctions one.
      res.locals.isFormManager = hasFormsRole(req.memberData);
      next();
    } catch (error) {
      next(error);
    }
  });

  async function buildProfileData(user, memberData, { staffView = false } = {}) {
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
    const roblox = await getLinkedRobloxData(user.id, { pool, fetchFn });
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
      const roblox = await getLinkedRobloxData(user.id, { pool, fetchFn });
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
      const profile = await buildProfileData(req.session.user, req.memberData);
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
  router.use('/documentation', createDocumentationRouter({ pool }));

  router.use('/members', requireAuth, (req, res, next) => {
    if (!req.memberData?.hasTargetRole) {
      return res.status(403).render('error', {
        title: 'Accès réservé',
        message: 'Cette section est réservée aux membres de la supervision.',
      });
    }
    next();
  });

  router.get('/members', async (req, res) => {
    try {
      const search = typeof req.query.q === 'string' ? req.query.q.trim().slice(0, 80) : '';
      const users = await fetchSiteUsers(search, pool);
      let nextIndex = 0;
      await Promise.all(Array.from({ length: Math.min(6, users.length) }, async () => {
        while (nextIndex < users.length) {
          const userIndex = nextIndex;
          nextIndex += 1;
          const member = users[userIndex];
          const roleData = await fetchGuildMemberRoles({ userId: member.discord_user_id, fetchFn });
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
      const member = await fetchSiteUser(req.params.discordUserId, pool);
      if (!member) {
        return res.status(404).render('error', {
          title: 'Membre introuvable',
          message: 'Aucune connexion web enregistrée pour ce compte.',
        });
      }
      const targetUser = {
        id: member.discord_user_id,
        username: member.discord_username,
        globalName: member.global_name,
        avatarUrl: member.avatar_url,
      };
      const roleData = await fetchGuildMemberRoles({ userId: targetUser.id, fetchFn });
      const profile = await buildProfileData(targetUser, roleData, { staffView: true });
      res.render('profile-detail', {
        title: `${targetUser.globalName} | Supervision`,
        ...profile,
        isStaffView: true,
        isReadOnly: true,
      });
    } catch (error) {
      console.error('[WebRoutes] Error rendering supervised profile:', error);
      res.status(500).render('error', {
        title: 'Erreur lors du chargement du profil',
        message: 'Impossible de charger la fiche de ce membre. Veuillez réessayer plus tard.',
      });
    }
  });

  return router;
}
