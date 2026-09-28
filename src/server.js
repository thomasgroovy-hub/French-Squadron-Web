import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import express from 'express';
import cookieParser from 'cookie-parser';
import { webConfig, validateWebConfig } from './config.js';
import { sessionMiddleware } from './auth/session.js';
import { createOAuthRouter } from './auth/oauth.js';
import { createMainRouter } from './routes/index.js';
import { createPermadeathRouter } from './routes/permadeath.js';

import { getDatabasePool, getSiteDatabasePool, findMissingEnv } from './database.js';
import { renderDiscordMarkdown } from './utils/discord-markdown.js';
import { printVersionBanner } from './version.js';

const SITE_DATABASE_VARS = ['SITE_MYSQL_HOST', 'SITE_MYSQL_USER', 'SITE_MYSQL_PASSWORD', 'SITE_MYSQL_DATABASE'];

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export function createApp({ pool, sitePool, fetchFn, config = webConfig } = {}) {
  if (pool === undefined) pool = getDatabasePool();
  if (sitePool === undefined) {
    try {
      sitePool = getSiteDatabasePool();
    } catch {
      sitePool = null;
    }
  }
  const app = express();

  // Configuration du moteur de vues EJS
  app.set('views', path.join(__dirname, 'views'));
  app.set('view engine', 'ejs');

  // Markdown helper, shared by every view. The function escapes the text it is
  // given, so views must print its result unescaped.
  app.locals.renderDiscordMarkdown = renderDiscordMarkdown;

  // Middleware pour envelopper automatiquement les vues dans layout.ejs
  app.use((req, res, next) => {
    const originalRender = res.render;
    res.render = function (view, options = {}, callback) {
      if (view === 'layout') {
        return originalRender.call(this, view, options, callback);
      }
      originalRender.call(this, view, options, (err, html) => {
        if (err) {
          if (callback) return callback(err);
          return next(err);
        }
        originalRender.call(
          this,
          'layout',
          {
            ...options,
            body: html,
            currentUser: req.session?.user || null,
            currentPath: req.originalUrl.split('?')[0],
            webConfig: {
              // Le footer sort vers Discord : l'URL vient de la configuration
              // serveur, jamais d'un lien écrit en dur dans la vue.
              discordUrl: config.discordUrl,
            },
          },
          callback
        );
      });
    };
    next();
  });

  // Middlewares généraux
  app.use(cookieParser());
  app.use(express.urlencoded({ extended: true }));
  app.use(express.json());
  app.use(sessionMiddleware());
  app.use(express.static(path.join(__dirname, 'public')));

  // Montage des routeurs
  app.use('/auth', createOAuthRouter({ config, fetchFn, pool }));
  app.use('/', createMainRouter({ pool, sitePool, fetchFn }));
  app.use('/', createPermadeathRouter({ pool }));
  

  // Gestion des pages non trouvées (404)
  app.use((req, res) => {
    res.status(404).render('error', {
      title: 'Page introuvable (404)',
      message: 'La page demandée n’existe pas ou a été déplacée.',
    });
  });

  // Gestionnaire global d'erreurs
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    console.error('[WebServer] Unhandled error:', err);
    // Si la réponse a déjà commencé, la réécriture des headers lèverait
    // ERR_HTTP_HEADERS_SENT : on délègue au handler par défaut d'Express,
    // qui coupe la connexion. Sans cette garde, le rendu de la page
    // d'erreur pouvait rester bloqué jusqu'au timeout du load balancer (502).
    if (res.headersSent) return next(err);
    const status = Number.isInteger(err?.status) ? err.status : 500;
    res.status(status).render('error', {
      title: 'Erreur interne du serveur',
      message: 'Une erreur inattendue est survenue lors du traitement de la requête.',
    });
  });

  return app;
}

export function startWebServer({
  port = webConfig.port,
  pool,
  sitePool,
} = {}) {
  printVersionBanner();

  const { valid, missing } = validateWebConfig();
  if (!valid) {
    console.warn(
      `[WebServer] Warning: Missing environment variables: ${missing.join(', ')}. Some OAuth features will be unavailable until set.`,
    );
  }

  let mainPool = pool;
  if (mainPool === undefined) {
    try {
      mainPool = getDatabasePool();
    } catch (error) {
      console.error([
        '',
        '================================================================',
        ' FPCS Companion Web refuses to start: no main MySQL pool.',
        ` Cause: ${error.message}`,
        '',
        ' Candidatures, responses, documentation, sanctions and Deaths all',
        ' read from this pool. Booting anyway would let the host report the',
        ' service as live while every one of those pages returns an error,',
        ' which is far harder to diagnose than a failed start.',
        '================================================================',
        '',
      ].join('\n'));
      process.exit(1);
    }
  }

  if (sitePool === undefined) {
    const missingSiteVars = findMissingEnv(SITE_DATABASE_VARS);
    if (missingSiteVars.length > 0) {
      console.warn(
        `[WebServer] The site database pool is disabled (missing: ${missingSiteVars.join(', ')}). `
        + 'Roblox verification and the member directory will report members as unlinked.',
      );
    }
    try {
      sitePool = getSiteDatabasePool();
    } catch {
      sitePool = null;
    }
  }

  // Uncaught exceptions leave the process in an undefined state: keeping it
  // alive would serve corrupted responses and hang in-flight requests until
  // the load balancer times them out. Exiting lets the host restart us with
  // a clean process and the real cause visible in the logs.
  process.on('uncaughtException', (err) => {
    console.error('[WebServer] UNCAUGHT EXCEPTION:', err);
    process.exit(1);
  });

  process.on('unhandledRejection', (reason) => {
    console.error('[WebServer] UNHANDLED REJECTION:', reason);
    process.exit(1);
  });

  const app = createApp({ pool: mainPool, sitePool });
  const server = app.listen(port, () => {
    console.log(`[WebServer] FPCS Companion Web listening on http://localhost:${port}`);
  });

  return server;
}

const isDirectRun = process.argv[1] && (
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1]) ||
  import.meta.url === pathToFileURL(process.argv[1]).href
);

if (isDirectRun) {
  startWebServer();
}
