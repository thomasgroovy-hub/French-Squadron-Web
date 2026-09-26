import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import express from 'express';
import cookieParser from 'cookie-parser';
import { webConfig, validateWebConfig } from './config.js';
import { sessionMiddleware } from './auth/session.js';
import { createOAuthRouter } from './auth/oauth.js';
import { createMainRouter } from './routes/index.js';

import { getDatabasePool, getSiteDatabasePool } from './database.js';

/**
 * Wrapper pour intercepter les erreurs asynchrones dans les routes Express.
 * Sans cela, les exceptions dans les handlers async ne sont pas catchées
 * par le middleware d'erreur Express 4 et font crasher le process (502).
 */
function asyncHandler(fn) {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export function createApp({ pool, sitePool, fetchFn, config = webConfig } = {}) {
  if (pool === undefined) pool = getDatabasePool();
  if (sitePool === undefined) sitePool = getSiteDatabasePool();
  const app = express();

  // Configuration du moteur de vues EJS
  app.set('views', path.join(__dirname, 'views'));
  app.set('view engine', 'ejs');

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
            // `req.path` est relatif au point de montage du routeur : dans un
            // sous-routeur (`/candidatures`, `/documentation`, ...) il vaut "/" et
            // non le chemin réel. `originalUrl` donne toujours le chemin complet.
            currentPath: req.originalUrl.split('?')[0],
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
    res.status(500).render('error', {
      title: 'Erreur interne du serveur',
      message: 'Une erreur inattendue est survenue lors du traitement de la requête.',
    });
  });

  return app;
}

export function startWebServer({
  port = webConfig.port,
  pool = getDatabasePool(),
  sitePool = getSiteDatabasePool(),
} = {}) {
  const { valid, missing } = validateWebConfig();
  if (!valid) {
    console.warn(
      `[WebServer] Warning: Missing environment variables: ${missing.join(', ')}. Some OAuth features will be unavailable until set.`
    );
  }

  // Gestionnaires globaux pour éviter les crashs silencieux (502)
  process.on('uncaughtException', (err) => {
    console.error('[WebServer] UNCAUGHT EXCEPTION:', err);
    // Ne pas exit(1) pour éviter le redémarrage en boucle sur Render
  });

  process.on('unhandledRejection', (reason, promise) => {
    console.error('[WebServer] UNHANDLED REJECTION at:', promise, 'reason:', reason);
  });

  const app = createApp({ pool, sitePool });
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
