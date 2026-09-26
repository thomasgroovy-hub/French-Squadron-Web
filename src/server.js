import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import express from 'express';
import cookieParser from 'cookie-parser';
import { webConfig, validateWebConfig } from './config.js';
import { sessionMiddleware } from './auth/session.js';
import { createOAuthRouter } from './auth/oauth.js';
import { createMainRouter } from './routes/index.js';
import { getDatabasePool } from './database.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export function createApp({ pool = getDatabasePool(), fetchFn, config = webConfig } = {}) {
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
          { ...options, body: html, currentUser: req.session?.user || null },
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

  // Montage des routeurs
  app.use('/auth', createOAuthRouter({ config, fetchFn }));
  app.use('/', createMainRouter({ pool, fetchFn }));

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
} = {}) {
  const { valid, missing } = validateWebConfig();
  if (!valid) {
    console.warn(
      `[WebServer] Warning: Missing environment variables: ${missing.join(', ')}. Some OAuth features will be unavailable until set.`
    );
  }

  const app = createApp({ pool });
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
