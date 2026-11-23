import crypto from 'node:crypto';
import { Router } from 'express';
import { webConfig } from '../config.js';
import { recordSiteLogin } from '../services/members.js';
import { getDatabasePool } from '../database.js';
import { deriveCsrfToken } from '../security/csrf.js';

const SNOWFLAKE_PATTERN = /^\d{17,20}$/;

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
    const { code, state, error } = req.query;

    // `error_description` comes straight from the query string and is echoed
    // into the page: only Discord's own error code decides the wording, the
    // attacker-supplied text never reaches the HTML.
    if (error) {
      return res.status(400).render('error', {
        title: 'Connexion refusée',
        message: 'La connexion via Discord a été annulée ou refusée. Vous pouvez réessayer.',
      });
    }

    const savedState = req.cookies?.oauth_state;
    res.clearCookie('oauth_state');

    if (typeof state !== 'string' || !savedState || state !== savedState) {
      return res.status(403).render('error', {
        title: 'Session invalide',
        message: 'Échec de vérification du jeton anti-CSRF. Veuillez réessayer de vous connecter.',
      });
    }

    if (typeof code !== 'string' || !code) {
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
      if (typeof tokenData?.access_token !== 'string' || !tokenData.access_token) {
        throw new Error('Réponse token invalide de Discord');
      }

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
      if (!SNOWFLAKE_PATTERN.test(String(discordUser.id || ''))) {
        throw new Error('Identifiant Discord invalide reçu du service');
      }

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

  /**
   * Logout stays a link for UX, but a bare GET would let any site force a
   * member out (classic login-CSRF sibling): the session-bound token must
   * travel with the request, as `_csrf` in the query or the body.
   */
  const handleLogout = (req, res) => {
    if (!req.session?.user) {
      return res.redirect('/');
    }
    // Sessions are sealed with webConfig.sessionSecret (see session.js), so
    // the token must be derived with the same key.
    const expected = deriveCsrfToken(req.session);
    const provided = (typeof req.query._csrf === 'string' && req.query._csrf)
      || (typeof req.body?._csrf === 'string' && req.body._csrf)
      || req.get('x-csrf-token')
      || '';
    const providedBuf = Buffer.from(String(provided), 'utf8');
    const expectedBuf = Buffer.from(String(expected), 'utf8');
    const valid = expectedBuf.length > 0
      && providedBuf.length === expectedBuf.length
      && crypto.timingSafeEqual(providedBuf, expectedBuf);
    if (!valid) {
      return res.status(403).render('error', {
        title: 'Requête bloquée (403)',
        message: 'Jeton de sécurité manquant ou expiré. Rechargez la page puis réessayez.',
      });
    }
    req.clearSession();
    return res.redirect('/');
  };

  router.get('/logout', handleLogout);
  router.post('/logout', handleLogout);

  return router;
}
