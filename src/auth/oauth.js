import crypto from 'node:crypto';
import { Router } from 'express';
import { webConfig } from '../config.js';
import { recordSiteLogin } from '../services/members.js';
import { getDatabasePool } from '../database.js';

export function createOAuthRouter({ config = webConfig, fetchFn = fetch, pool = getDatabasePool() } = {}) {
  const router = Router();

  router.get('/discord', (req, res) => {
    if (!config.clientId || !config.clientSecret) {
      return res.status(500).render('error', {
        title: 'Configuration OAuth2 manquante',
        message: 'L’application Discord OAuth2 n’est pas encore configurée (variables DISCORD_APPLICATION_ID ou DISCORD_CLIENT_SECRET manquantes).',
      });
    }

    const state = crypto.randomBytes(16).toString('hex');
    res.cookie('oauth_state', state, {
      httpOnly: true,
      secure: config.isProduction,
      sameSite: 'lax',
      maxAge: 10 * 60 * 1000, // 10 minutes
    });

    const params = new URLSearchParams({
      client_id: config.clientId,
      redirect_uri: config.redirectUri,
      response_type: 'code',
      scope: 'identify',
      state,
      prompt: 'consent',
    });

    res.redirect(`https://discord.com/oauth2/authorize?${params.toString()}`);
  });

  router.get('/discord/callback', async (req, res) => {
    const { code, state, error, error_description } = req.query;

    if (error) {
      return res.status(400).render('error', {
        title: 'Connexion refusée',
        message: error_description || 'La connexion via Discord a été annulée ou refusée.',
      });
    }

    const savedState = req.cookies?.oauth_state;
    res.clearCookie('oauth_state');

    if (!state || !savedState || state !== savedState) {
      return res.status(403).render('error', {
        title: 'Session invalide',
        message: 'Échec de vérification du jeton anti-CSRF. Veuillez réessayer de vous connecter.',
      });
    }

    if (!code) {
      return res.status(400).render('error', {
        title: 'Code manquant',
        message: 'Aucun code d’autorisation n’a été reçu de Discord.',
      });
    }

    try {
      // 1. Échange du code contre l'access_token
      const tokenResponse = await fetchFn('https://discord.com/api/v10/oauth2/token', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({
          client_id: config.clientId,
          client_secret: config.clientSecret,
          grant_type: 'authorization_code',
          code: String(code),
          redirect_uri: config.redirectUri,
        }),
      });

      if (!tokenResponse.ok) {
        const errorText = await tokenResponse.text();
        console.error('[OAuth2] Token exchange error:', errorText);
        return res.status(400).render('error', {
          title: 'Erreur d’authentification',
          message: 'Impossible d’échanger le code d’autorisation avec Discord. Vérifiez la configuration de l’URL de redirection.',
        });
      }

      const tokenData = await tokenResponse.json();

      // 2. Récupération de l'utilisateur Discord
      const userResponse = await fetchFn('https://discord.com/api/v10/users/@me', {
        headers: {
          Authorization: `Bearer ${tokenData.access_token}`,
        },
      });

      if (!userResponse.ok) {
        throw new Error(`Échec de récupération du profil Discord: ${userResponse.status}`);
      }

      const discordUser = await userResponse.json();

      // Formatage de l'avatar Discord
      const avatarUrl = discordUser.avatar
        ? `https://cdn.discordapp.com/avatars/${discordUser.id}/${discordUser.avatar}.png?size=256`
        : `https://cdn.discordapp.com/embed/avatars/${(BigInt(discordUser.id) >> 22n) % 6n}.png`;

      // 3. Stockage en session sécurisée
      const sessionUser = {
        id: discordUser.id,
        username: discordUser.username,
        globalName: discordUser.global_name || discordUser.username,
        avatar: discordUser.avatar,
        avatarUrl,
      };
      req.setSession({ user: sessionUser });
      await recordSiteLogin(sessionUser, pool);

      res.redirect('/');
    } catch (err) {
      console.error('[OAuth2] Authentication error:', err);
      res.status(500).render('error', {
        title: 'Erreur serveur',
        message: 'Une erreur est survenue lors de l’authentification avec Discord.',
      });
    }
  });

  router.get('/logout', (req, res) => {
    req.clearSession();
    res.redirect('/');
  });

  return router;
}
