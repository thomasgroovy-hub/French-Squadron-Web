import { Router } from 'express';
import { requireAuth } from '../auth/session.js';
import { webConfig } from '../config.js';
import {
  fetchGuildMemberRoles,
  formatAccountAge,
  formatDate,
  getDiscordCreationDate,
} from '../services/discord.js';
import { getLinkedRobloxData } from '../services/roblox.js';
import { fetchMemberSanctions } from '../services/sanctions.js';

export function createMainRouter({ pool, fetchFn } = {}) {
  const router = Router();

  router.get('/', (req, res) => {
    if (req.session?.user) {
      return res.redirect('/profile');
    }
    res.render('home', {
      title: 'Accueil — French Squadron Utilities',
    });
  });

  router.get('/profile', requireAuth, async (req, res) => {
    const user = req.session.user;

    try {
      // 1. Informations Discord calculées
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

      // 2. Vérification du rôle Discord via le token du Bot
      const memberData = await fetchGuildMemberRoles({
        userId: user.id,
        fetchFn,
      });

      const hasTargetRole = Boolean(memberData.hasTargetRole);

      // 3. Récupération du profil Roblox lié
      const roblox = await getLinkedRobloxData(user.id, { pool, fetchFn });

      // 4. Récupération conditionnelle de la fiche de sanctions
      let sanctions = null;
      if (hasTargetRole) {
        sanctions = await fetchMemberSanctions(user.id, pool);
      }

      res.render('profile', {
        title: 'Mon Profil — French Squadron Utilities',
        discordInfo,
        memberData,
        roblox,
        hasTargetRole,
        sanctions,
        targetRoleId: webConfig.targetRoleId,
      });
    } catch (error) {
      console.error('[WebRoutes] Error rendering profile:', error);
      res.status(500).render('error', {
        title: 'Erreur lors du chargement du profil',
        message: 'Impossible de charger l’ensemble des informations du profil. Veuillez réessayer plus tard.',
      });
    }
  });

  return router;
}
