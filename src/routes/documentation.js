import { Router } from 'express';
import { requireAuth } from '../auth/session.js';
import { hasFormsRole, requireFormsRole } from '../auth/guards.js';
import {
  DOC_BLOCK_TYPES,
  DOC_BLOCK_TYPE_VALUES,
  createDocumentationBlock,
  deleteDocumentationBlock,
  ensureDocumentationTables,
  listDocumentationBlocks,
  moveDocumentationBlock,
  updateDocumentationBlock,
} from '../services/documentation.js';

const FIELD_LABELS = Object.freeze({
  [DOC_BLOCK_TYPES.HEADING]: { label: 'Titre de section', needsTitle: true, needsContent: false, needsUrl: false },
  [DOC_BLOCK_TYPES.TEXT]: { label: 'Bloc de texte', needsTitle: false, needsContent: true, needsUrl: false },
  [DOC_BLOCK_TYPES.LINK]: { label: 'Lien', needsTitle: true, needsContent: false, needsUrl: true },
  [DOC_BLOCK_TYPES.BULLETS]: { label: 'Liste à puces', needsTitle: false, needsContent: true, needsUrl: false },
});

const MAX_CONTENT_LENGTH = 4000;
const MAX_TITLE_LENGTH = 200;
const MAX_URL_LENGTH = 1024;

function cleanText(value, maxLength) {
  if (typeof value !== 'string') return '';
  return value.replace(/\r\n/g, '\n').trim().slice(0, maxLength);
}

/**
 * Only absolute http(s) URLs are accepted so a documentation block can never
 * smuggle a `javascript:` or `data:` link into the page.
 */
function cleanUrl(value) {
  const url = cleanText(value, MAX_URL_LENGTH);
  if (!url) return '';
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return '';
    return parsed.toString();
  } catch {
    return '';
  }
}

function parseBlockInput(body) {
  const blockType = DOC_BLOCK_TYPE_VALUES.includes(body?.block_type)
    ? body.block_type
    : DOC_BLOCK_TYPES.TEXT;
  const shape = FIELD_LABELS[blockType];

  return {
    blockType,
    title: shape.needsTitle ? cleanText(body?.title, MAX_TITLE_LENGTH) : '',
    content: shape.needsContent ? cleanText(body?.content, MAX_CONTENT_LENGTH) : '',
    url: shape.needsUrl ? cleanUrl(body?.url) : '',
  };
}

function validateBlockInput(input) {
  const shape = FIELD_LABELS[input.blockType];
  if (shape.needsTitle && !input.title) return 'Le libellé de ce bloc est obligatoire.';
  if (shape.needsContent && !input.content) return 'Le contenu de ce bloc est obligatoire.';
  if (shape.needsUrl && !input.url) return 'L’adresse du lien est obligatoire (http:// ou https://).';
  return null;
}

function toBulletItems(content) {
  return String(content || '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

/**
 * « Documentation » tab: read-only for every logged-in user, with a management
 * panel for the forms/documentation role. Mounted as
 * `router.use('/documentation', createDocumentationRouter(...))` so paths are
 * relative and the auth guard stays scoped to this tab.
 */
export function createDocumentationRouter({ pool } = {}) {
  const router = Router();

  /** Flattens a stored block into the shape the view renders directly. */
  function describeBlock(block) {
    const typeLabels = {
      [DOC_BLOCK_TYPES.HEADING]: 'Titre',
      [DOC_BLOCK_TYPES.TEXT]: 'Texte',
      [DOC_BLOCK_TYPES.LINK]: 'Lien',
      [DOC_BLOCK_TYPES.BULLETS]: 'Liste à puces',
    };
    const items = block.blockType === DOC_BLOCK_TYPES.BULLETS ? toBulletItems(block.content) : [];
    const preview = block.blockType === DOC_BLOCK_TYPES.BULLETS
      ? items.join(' · ')
      : (block.content || block.url || '');
    return {
      ...block,
      type: block.blockType,
      typeLabel: typeLabels[block.blockType] || block.blockType,
      items,
      preview: preview.length > 160 ? `${preview.slice(0, 160)}…` : preview,
    };
  }

  // Public, read-only view of the published blocks.
  router.get('/', requireAuth, async (req, res) => {
    try {
      const blocks = await listDocumentationBlocks(pool);

      res.render('documentation', {
        title: 'Documentation | Site-66',
        blocks: blocks.map(describeBlock),
        isFormManager: hasFormsRole(req.memberData),
        error: cleanText(req.query.erreur, 200) || null,
        notice: cleanText(req.query.info, 200) || null,
      });
    } catch (error) {
      console.error('[WebRoutes] Error loading documentation:', error);
      res.status(500).render('error', {
        title: 'Erreur lors du chargement de la documentation',
        message: 'Impossible de charger la documentation. Veuillez réessayer plus tard.',
      });
    }
  });

  // Every mutating route below is role-gated on the server, not just hidden in
  // the markup.
  router.post('/blocs', requireFormsRole, async (req, res) => {
    const input = parseBlockInput(req.body);
    const error = validateBlockInput(input);
    if (error) return redirectWithError(res, error);

    try {
      await ensureDocumentationTables(pool);
      await createDocumentationBlock({ ...input, pool });
      return res.redirect('/documentation?info=' + encodeURIComponent('Bloc ajouté.'));
    } catch (creationError) {
      console.error('[WebRoutes] Error creating documentation block:', creationError);
      return redirectWithError(res, 'Impossible d’enregistrer ce bloc.');
    }
  });

  router.post('/blocs/:blockId', requireFormsRole, async (req, res) => {
    const blockId = Number.parseInt(req.params.blockId, 10);
    const input = parseBlockInput(req.body);
    const error = validateBlockInput(input);
    if (error) return redirectWithError(res, error);

    try {
      await ensureDocumentationTables(pool);
      const updated = await updateDocumentationBlock({ blockId, ...input, pool });
      if (!updated) return res.status(404).render('error', {
        title: 'Bloc introuvable',
        message: 'Ce bloc de documentation n’existe plus.',
      });
      return res.redirect('/documentation?info=' + encodeURIComponent('Bloc mis à jour.'));
    } catch (updateError) {
      console.error('[WebRoutes] Error updating documentation block:', updateError);
      return redirectWithError(res, 'Impossible de mettre à jour ce bloc.');
    }
  });

  router.post('/blocs/:blockId/deplacer', requireFormsRole, async (req, res) => {
    const blockId = Number.parseInt(req.params.blockId, 10);
    const direction = cleanText(req.body?.direction, 8) === 'haut' ? -1 : 1;
    try {
      await ensureDocumentationTables(pool);
      await moveDocumentationBlock(blockId, direction, pool);
      return res.redirect('/documentation');
    } catch (moveError) {
      console.error('[WebRoutes] Error reordering documentation block:', moveError);
      return redirectWithError(res, 'Impossible de réordonner ce bloc.');
    }
  });

  router.post('/blocs/:blockId/supprimer', requireFormsRole, async (req, res) => {
    const blockId = Number.parseInt(req.params.blockId, 10);
    try {
      await ensureDocumentationTables(pool);
      const removed = await deleteDocumentationBlock(blockId, pool);
      if (!removed) return res.status(404).render('error', {
        title: 'Bloc introuvable',
        message: 'Ce bloc de documentation n’existe plus.',
      });
      return res.redirect('/documentation?info=' + encodeURIComponent('Bloc supprimé.'));
    } catch (deleteError) {
      console.error('[WebRoutes] Error deleting documentation block:', deleteError);
      return redirectWithError(res, 'Impossible de supprimer ce bloc.');
    }
  });

  function redirectWithError(res, message) {
    return res.redirect('/documentation?erreur=' + encodeURIComponent(message));
  }

  return router;
}
