import './helpers/env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import ejs from 'ejs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const viewsDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'views');
const layout = fs.readFileSync(path.join(viewsDir, 'layout.ejs'), 'utf8');

const base = {
  currentUser: { username: 'alice', globalName: 'Alice', avatarUrl: null },
  currentPath: '/candidatures',
  isStaff: false,
  isFormManager: true,
};

const form = {
  id: 7,
  title: 'Recrutement pilote',
  description: 'Rejoignez l’escadrille.',
  grantedRoleId: '1532037579816570981',
  grantedRoleName: 'Pilote',
  status: 'open',
  statusLabel: 'Ouvert',
  responseCount: 3,
  pendingCount: 2,
  questions: [
    { id: 11, label: 'Pourquoi nous rejoindre ?', helpText: 'Sois concis.', fieldType: 'short' },
    { id: 12, label: 'Présentation', helpText: '', fieldType: 'long' },
  ],
};

const pendingResponse = {
  id: 42,
  formId: 7,
  formTitle: form.title,
  applicantDiscordId: '222',
  status: 'pending',
  statusLabel: 'En attente',
  createdAt: '2026-01-02',
  reviewedAt: null,
  grantedRoleId: '1532037579816570981',
  grantedRoleName: 'Pilote',
  answers: { 11: 'Parce que.', 12: 'Ligne 1\nLigne 2' },
  questions: form.questions,
};

// Mirrors what `describeBlock` in routes/documentation.js hands to the view.
const blocks = [
  { id: 1, type: 'heading', typeLabel: 'Titre', tone: 'cyan', icon: 'heading', title: 'Règlement', content: '', url: '', items: [], preview: 'Règlement' },
  { id: 2, type: 'text', typeLabel: 'Texte', tone: 'cyan', icon: 'text', title: '', content: 'Texte', url: '', items: [], preview: 'Texte' },
  { id: 3, type: 'link', typeLabel: 'Lien', tone: 'success', icon: 'link', title: 'Discord', content: '', url: 'https://discord.com', items: [], preview: 'Discord' },
  { id: 4, type: 'bullets', typeLabel: 'Liste à puces', tone: 'success', icon: 'bullets', title: '', content: 'a\nb', url: '', items: ['a', 'b'], preview: 'a · b' },
];

/** Renders a view inside the real layout, the way `server.js` does. */
function renderPage(view, data) {
  const filename = path.join(viewsDir, `${view}.ejs`);
  const body = ejs.render(fs.readFileSync(filename, 'utf8'), data, { filename });
  return ejs.render(layout, { ...data, body }, { filename: path.join(viewsDir, 'layout.ejs') });
}

/** Renders a view on its own, without the layout. Structural assertions use this so
 *  they can't accidentally match the shared CSS/JS shipped in `<head>`. */
function renderView(view, data) {
  const filename = path.join(viewsDir, `${view}.ejs`);
  return ejs.render(fs.readFileSync(filename, 'utf8'), data, { filename });
}

const pages = {
  'candidatures list (manager)': ['forms', {
    forms: [form], ownForms: [form], isFormManager: true, justSubmitted: false, submittedFormIds: new Set([7]),
  }],
  'candidatures list (empty)': ['forms', {
    forms: [], ownForms: [], isFormManager: false, justSubmitted: true, submittedFormIds: new Set(),
  }],
  'form builder': ['form-builder', {
    form, isNew: false, error: null, notice: 'Enregistré.', cooldownMinutes: 30, publishBlock: 12,
  }],
  'form builder (new, with validation error)': ['form-builder', {
    form: { ...form, id: null, questions: [{ id: null, label: '', helpText: '', fieldType: 'short' }] },
    isNew: true, error: 'Titre requis', notice: null, cooldownMinutes: 0, publishBlock: null,
  }],
  'form filling': ['form-fill', { form, answers: {}, alreadySubmitted: false, error: null }],
  'form filling (already applied)': ['form-fill', { form, answers: { 11: 'x' }, alreadySubmitted: true, error: null }],
  'responses inbox': ['responses', {
    entries: [{
      form,
      stats: { total: 3, pending: 2, accepted: 1, rejected: 0 },
      responses: [pendingResponse, { ...pendingResponse, id: 43, status: 'accepted', statusLabel: 'Acceptée', reviewedAt: '2026-01-03' }],
    }],
    pendingCount: 2,
    filter: 'all',
  }],
  'responses inbox (empty)': ['responses', { entries: [], pendingCount: 0, filter: 'all' }],
  'response detail (pending)': ['response-detail', {
    currentPath: '/reponses', response: pendingResponse, applicantName: 'Bob', applicantUsername: 'bob', applicantAvatarUrl: null, notice: null, warning: null,
  }],
  'response detail (processed, with warning)': ['response-detail', {
    currentPath: '/reponses',
    response: { ...pendingResponse, status: 'accepted', statusLabel: 'Acceptée', reviewedAt: '2026-01-04', grantedRoleName: null },
    applicantName: 'Bob', applicantUsername: 'bob', applicantAvatarUrl: null, notice: 'Candidature acceptée.', warning: 'MP impossible.',
  }],
  'documentation (manager)': ['documentation', { currentPath: '/documentation', blocks, isFormManager: true, error: null, notice: 'Bloc ajouté.' }],
  'documentation (empty, reader)': ['documentation', { currentPath: '/documentation', blocks: [], isFormManager: false, error: null, notice: null }],
  'dashboard': ['dashboard', { currentPath: '/', isConnected: true, roblox: null }],
  'dashboard (reader)': ['dashboard', { currentPath: '/', isConnected: true, roblox: null, isFormManager: false }],
  'dashboard (roblox linked)': ['dashboard', { currentPath: '/', isConnected: true, roblox: { isLinked: true, data: { username: 'Rob', avatarUrl: null } } }],
  'dashboard (anonymous)': ['dashboard', { currentPath: '/', isConnected: false, isFormManager: false, currentUser: null }],
};

for (const [name, [view, data]] of Object.entries(pages)) {
  test(`view renders: ${name}`, () => {
    const html = renderPage(view, { ...base, ...data });
    assert.ok(html.includes('<!DOCTYPE html>'), 'the page is wrapped in the layout');
  });
}

test('every view file compiles', () => {
  for (const file of fs.readdirSync(viewsDir).filter((name) => name.endsWith('.ejs'))) {
    const filename = path.join(viewsDir, file);
    assert.doesNotThrow(() => ejs.compile(fs.readFileSync(filename, 'utf8'), { filename }), file);
  }
});

test('layout exposes Candidatures and Documentation to everyone, Réponses only to the forms role', () => {
  const listData = { forms: [form], ownForms: [], submittedFormIds: new Set(), justSubmitted: false };
  const asReader = renderPage('forms', { ...base, ...listData, isFormManager: false });
  assert.match(asReader, /href="\/candidatures"/);
  assert.match(asReader, /href="\/documentation"/);
  assert.doesNotMatch(asReader, /href="\/reponses"/);

  const asManager = renderPage('forms', { ...base, ...listData, isFormManager: true, ownForms: [form] });
  assert.match(asManager, /href="\/reponses"/);
});

test('the Candidatures placeholder is gone from the layout and the dashboard', () => {
  assert.doesNotMatch(layout, /Bientôt/);
  const dashboard = renderPage('dashboard', { ...base, currentPath: '/', isConnected: true, roblox: null });
  assert.doesNotMatch(dashboard, /Bientôt|À venir/);
  assert.match(dashboard, /href="\/candidatures"/);
  assert.match(dashboard, /href="\/documentation"/);
});

test('form filling renders one input per question, matching its field type', () => {
  const html = renderPage('form-fill', { ...base, form, answers: {}, alreadySubmitted: false, error: null });
  assert.match(html, /name="answer_11"/);
  assert.match(html, /name="answer_12"/);
  assert.match(html, /<textarea[^>]*name="answer_12"/, 'a long question renders a textarea');
  assert.doesNotMatch(html, /<textarea[^>]*name="answer_11"/, 'a short question renders a plain input');
  assert.match(html, /Envoyer ma candidature/);
});

test('documentation link blocks always carry a safe target', () => {
  const html = renderPage('documentation', { ...base, currentPath: '/documentation', blocks, isFormManager: true, error: null, notice: null });
  assert.match(html, /href="https:\/\/discord\.com"[^>]*rel="noopener noreferrer"/);
  assert.match(html, /<h2 class="doc-heading">Règlement<\/h2>/);
  assert.match(html, /<li>a<\/li>/);
  assert.match(html, /<li>b<\/li>/);
});

test('documentation hides its management panel from plain readers', () => {
  const asReader = renderView('documentation', { ...base, currentPath: '/documentation', blocks, isFormManager: false, error: null, notice: null });
  assert.doesNotMatch(asReader, /Ajouter un bloc/);
  assert.doesNotMatch(asReader, /\/documentation\/blocs/);
  // The published content stays visible.
  assert.match(asReader, /Règlement/);
});

test('every documentation block renders in its own card, with the published markup', () => {
  const html = renderView('documentation', { ...base, currentPath: '/documentation', blocks, isFormManager: true, error: null, notice: null });

  // Une carte par bloc, dans l'ordre de publication.
  assert.equal(html.match(/<article class="doc-block-card"/g)?.length, blocks.length);
  assert.deepEqual(
    [...html.matchAll(/data-block-id="(\d+)"/g)].map((match) => Number(match[1])),
    [1, 2, 3, 4],
  );

  // L'aperçu est le rendu réel, pas une chaîne tronquée à part.
  assert.match(html, /<h2 class="doc-heading">Règlement<\/h2>/);
  assert.match(html, /<p class="doc-text">Texte<\/p>/);
  assert.match(html, /<a class="doc-link" href="https:\/\/discord\.com"[^>]*>Discord<\/a>/);
  assert.match(html, /<ul class="doc-bullets">[\s\S]*<li>a<\/li>[\s\S]*<li>b<\/li>[\s\S]*<\/ul>/);
  // L'ancien aperçu tronqué a disparu de la carte.
  assert.doesNotMatch(html, /class="doc-preview"/);
});

test('documentation cards carry the tone and badge of their block type', () => {
  const doc = { ...base, currentPath: '/documentation', blocks, isFormManager: true, error: null, notice: null };
  const html = renderView('documentation', doc);

  // heading/text en cyan, link/bullets en success, d'après BLOCK_STYLES.
  assert.equal(html.match(/data-tone="cyan" data-block-id/g)?.length, 2);
  assert.equal(html.match(/data-tone="success" data-block-id/g)?.length, 2);
  // La carte de création porte elle aussi le ton de son type par défaut (Texte),
  // d'où le badge cyan supplémentaire.
  assert.equal(html.match(/class="badge badge-cyan"/g)?.length, 3);
  assert.equal(html.match(/class="badge badge-success"/g)?.length, 2);

  // La couleur vient des variables du thème, pas d'un littéral.
  const css = renderPage('documentation', doc);
  assert.match(css, /\.doc-block-card\[data-tone="cyan"\] \{ border-left-color: var\(--accent\); \}/);
  assert.match(css, /\.doc-block-card\[data-tone="success"\] \{ border-left-color: var\(--success\); \}/);
});

test('each documentation card carries its own in-place edit form', () => {
  const html = renderView('documentation', { ...base, currentPath: '/documentation', blocks, isFormManager: true, error: null, notice: null });

  for (const block of blocks) {
    assert.match(html, new RegExp(`action="/documentation/blocs/${block.id}"`), `le bloc ${block.id} a son formulaire`);
    assert.match(html, new RegExp(`id="doc-title-${block.id}"[^>]*value="${block.title}"`));
    assert.match(html, new RegExp(`id="doc-content-${block.id}"[^>]*>[\\s\\S]*?</textarea>`));
    assert.match(html, new RegExp(`id="doc-url-${block.id}"[^>]*value="${block.url}"`));
  }
  // Un formulaire d'édition par bloc, chacun caché dans un <details>.
  assert.equal(html.match(/<details class="doc-card-edit">/g)?.length, blocks.length);
  assert.equal(html.match(/action="\/documentation\/blocs\/\d+"/g)?.length, blocks.length);
  // Les valeurs pré-remplies correspondent bien au bloc.
  assert.match(html, /id="doc-content-4"[\s\S]*?>a\nb</);
  assert.match(html, /<option value="bullets" selected>Liste<\/option>/);
});

test('the documentation type picker offers the four block types', () => {
  const html = renderView('documentation', { ...base, currentPath: '/documentation', blocks, isFormManager: true, error: null, notice: null });

  for (const label of ['Titre', 'Texte', 'Lien', 'Liste']) {
    assert.match(html, new RegExp(`>${label}</button>`), `le bouton ${label} existe`);
  }
  // Un seul champ `block_type` par formulaire : le select pilote, ou le ferait sans JS.
  assert.equal(html.match(/<form[^>]*data-typed-form/g)?.length, blocks.length + 1);
  assert.equal(html.match(/<select[^>]*name="block_type"/g)?.length, blocks.length + 1);
});

test('the documentation card order can be saved in one request', () => {
  const html = renderView('documentation', { ...base, currentPath: '/documentation', blocks, isFormManager: true, error: null, notice: null });

  assert.match(html, /action="\/documentation\/blocs\/reordonner"/);
  assert.match(html, /id="doc-reorder-form"/);
  // Les ids sont serialisés par le script, un seul envoi à la fin du drag.
  assert.match(html, /input\.name = 'block_id'/);
  assert.match(html, /reorderForm\.submit\(\)/);
  assert.equal(html.match(/reorderForm\.submit\(\)/g)?.length, 1);
  // Le repli sans JavaScript reste disponible sur chaque carte.
  assert.equal(html.match(/name="direction" value="up"/g)?.length, blocks.length);
  assert.equal(html.match(/name="direction" value="down"/g)?.length, blocks.length);
  assert.match(html, /\/deplacer/);
});

test('an empty documentation offers the creation card instead of a dead end', () => {
  const html = renderView('documentation', { ...base, currentPath: '/documentation', blocks: [], isFormManager: true, error: null, notice: null });

  // L'état vide vit dans la carte de création, pas au-dessus d'un formulaire.
  assert.match(html, /class="doc-block-card doc-new-card"[\s\S]*La documentation est vide/);
  assert.match(html, /action="\/documentation\/blocs" method="post"/);
  // Une seule carte, et un seul état vide : celui qu'elle contient.
  assert.equal(html.match(/class="empty-state"/g)?.length, 1);
  assert.equal(html.match(/<article class="doc-block-card/g)?.length, 1);
});

test('a reader without the forms role gets no edit, reorder or creation card', () => {
  const asReader = renderView('documentation', { ...base, currentPath: '/documentation', blocks, isFormManager: false, error: null, notice: null });

  assert.doesNotMatch(asReader, /doc-card-edit/);
  assert.doesNotMatch(asReader, /doc-new-card/);
  assert.doesNotMatch(asReader, /doc-reorder-form/);
  assert.doesNotMatch(asReader, /data-confirm="Supprimer ce bloc/);
  assert.doesNotMatch(asReader, /deplacer|supprimer|reordonner/);
  assert.doesNotMatch(asReader, /draggable="true"/);
  // Le contenu publié, lui, reste complet.
  assert.match(asReader, /<h2 class="doc-heading">Règlement<\/h2>/);
  assert.match(asReader, /<li>a<\/li>/);

  // Une page vide reste lisible, sans carte de création.
  const emptyReader = renderView('documentation', { ...base, currentPath: '/documentation', blocks: [], isFormManager: false, error: null, notice: null });
  assert.doesNotMatch(emptyReader, /doc-new-card/);
  assert.match(emptyReader, /Aucun contenu n/);
});
