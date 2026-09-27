import './helpers/env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import ejs from 'ejs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderDiscordMarkdown } from '../src/utils/discord-markdown.js';

const viewsDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'views');
const layout = fs.readFileSync(path.join(viewsDir, 'layout.ejs'), 'utf8');

const base = {
  currentUser: { username: 'alice', globalName: 'Alice', avatarUrl: null },
  currentPath: '/candidatures',
  isStaff: false,
  isFormManager: true,
  webConfig: { documentationEnabled: true },
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
  { id: 5, type: 'separator', typeLabel: 'Séparateur', tone: 'neutral', icon: 'separator', title: '', content: '', url: '', items: [], preview: '' },
];

/** Renders a view inside the real layout, the way `server.js` does. */
function renderPage(view, data) {
  const filename = path.join(viewsDir, `${view}.ejs`);
  const body = renderView(view, data);
  return ejs.render(layout, { ...data, body }, { filename: path.join(viewsDir, 'layout.ejs') });
}

/** Renders a view on its own, without the layout. Structural assertions use this so
 *  they can't accidentally match the shared CSS/JS shipped in `<head>`. */
function renderView(view, data) {
  const filename = path.join(viewsDir, `${view}.ejs`);
  // server.js publishes the markdown helper on app.locals; mirror that here so
  // the views are exercised with the real renderer, not a stub.
  return ejs.render(fs.readFileSync(filename, 'utf8'), { renderDiscordMarkdown, ...data }, { filename });
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

test('a text block is rendered as Discord markdown, not as raw source', () => {
  const markdown = [{ ...blocks[1], content: '**Gras**, `code`\n- un\n- deux\n\n> cité' }];
  const data = { ...base, currentPath: '/documentation', blocks: markdown, error: null, notice: null };

  const html = renderView('documentation', { ...data, isFormManager: true });
  assert.match(html, /<strong>Gras<\/strong>/);
  assert.match(html, /<code class="doc-inline-code">code<\/code>/);
  assert.match(html, /<ul class="doc-md-list"><li>un<\/li><li>deux<\/li><\/ul>/);
  assert.match(html, /<blockquote class="doc-quote">cité<\/blockquote>/);

  // Chez un lecteur il n'y a ni éditeur ni textarea : la seule trace des
  // marqueurs serait une chaîne mal rendue, donc ils doivent avoir disparu.
  const asReader = renderView('documentation', { ...data, isFormManager: false });
  assert.doesNotMatch(asReader, /\*\*Gras\*\*/);
  assert.doesNotMatch(asReader, /`code`/);
  assert.doesNotMatch(asReader, /^- un$/m);
  assert.match(asReader, /<strong>Gras<\/strong>/);
});

test('every block renders with the published markup, and the separator as a rule', () => {
  const html = renderView('documentation', { ...base, currentPath: '/documentation', blocks, isFormManager: true, error: null, notice: null });

  // Une ligne par bloc, dans l'ordre de publication.
  assert.deepEqual(
    [...html.matchAll(/data-block-id="(\d+)"/g)].map((match) => Number(match[1])),
    blocks.map((block) => block.id),
  );

  assert.match(html, /<h2 class="doc-heading">Règlement<\/h2>/);
  assert.match(html, /<p class="doc-text">Texte<\/p>/);
  assert.match(html, /<a class="doc-link" href="https:\/\/discord\.com"[^>]*>Discord<\/a>/);
  assert.match(html, /<ul class="doc-bullets">[\s\S]*<li>a<\/li>[\s\S]*<li>b<\/li>[\s\S]*<\/ul>/);
  assert.match(html, /<hr class="doc-separator">/);
  // Le rendu n'est plus entouré d'un cadre de carte.
  assert.doesNotMatch(html, /class="doc-block-card/);
  assert.equal(html.match(/<section class="card"/g)?.length, 1, 'seul l’en-tête garde son conteneur de page');
  assert.doesNotMatch(html, /<details|doc-new-card|Ajouter un bloc/);
  assert.doesNotMatch(html, /class="doc-preview"/);
});

test('a block whose fields carry HTML is escaped, not rendered as markup', () => {
  // Le serveur ne fait que normaliser ces champs : le rendu doit les échapper.
  const hostile = [
    { ...blocks[0], title: '<img src=x onerror=alert(1)>' },
    { ...blocks[2], title: '</a><script>alert(1)</script>', url: 'https://ok.example/?a=1&b=2' },
    { ...blocks[3], items: ['<b>gras</b>', '"><svg onload=alert(1)>'] },
  ];
  const asReader = renderView('documentation', { ...base, currentPath: '/documentation', blocks: hostile, isFormManager: false, error: null, notice: null });

  assert.doesNotMatch(asReader, /<img src=x/);
  assert.doesNotMatch(asReader, /<script>/);
  assert.doesNotMatch(asReader, /<svg onload/);
  assert.match(asReader, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.match(asReader, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(asReader, /&lt;b&gt;gras&lt;\/b&gt;/);
  // L'URL reste un lien valide, avec son & échappé une seule fois.
  assert.match(asReader, /href="https:\/\/ok\.example\/\?a=1&amp;b=2"/);
  assert.doesNotMatch(asReader, /&amp;amp;/);

  // Le markdown, lui, reste rendered : c'est le seul HTML autorisé ici.
  const markdown = renderView('documentation', { ...base, currentPath: '/documentation', blocks: [{ ...blocks[1], content: '<script>alert(1)</script>' }], isFormManager: false, error: null, notice: null });
  assert.doesNotMatch(markdown, /<script>/);
  assert.match(markdown, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
});

test('the editor chrome is hidden until the row is hovered or focused', () => {
  const doc = { ...base, currentPath: '/documentation', blocks, isFormManager: true, error: null, notice: null };
  const css = renderPage('documentation', doc);

  // Les actions et la poignée commencent invisibles, et se révèlent au survol
  // comme au focus clavier, pour rester accessibles sans souris.
  assert.match(css, /\.doc-row-actions \{[^}]*opacity: 0;/);
  assert.match(css, /\.doc-row:hover \.doc-row-actions, \.doc-row:focus-within \.doc-row-actions \{ opacity: 1; \}/);
  assert.match(css, /\.doc-insert-btn \{[^}]*opacity: 0;/);
  assert.match(css, /\.doc-insert:hover \.doc-insert-btn/);
});

test('each block is edited in place, with the markdown toolbar and the shortcuts', () => {
  const html = renderView('documentation', { ...base, currentPath: '/documentation', blocks, isFormManager: true, error: null, notice: null });

  for (const block of blocks) {
    assert.match(html, new RegExp(`<form class="doc-edit" action="/documentation/blocs/${block.id}"`), `le bloc ${block.id} a son formulaire`);
    assert.match(html, new RegExp(`id="doc-title-${block.id}"[^>]*value="${block.title}"`));
    assert.match(html, new RegExp(`id="doc-content-${block.id}"[^>]*>[\\s\\S]*?</textarea>`));
    assert.match(html, new RegExp(`id="doc-url-${block.id}"[^>]*value="${block.url}"`));
  }
  assert.equal(html.match(/<form class="doc-edit"/g)?.length, blocks.length);
  // La zone d'édition est masquée tant qu'on ne demande pas à modifier.
  assert.equal(html.match(/class="doc-edit"[^>]*hidden/g)?.length, blocks.length);
  assert.match(html, /<div class="doc-row-body" data-doc-body>/);

  // La barre d'outils entoure la sélection avec les bons délimiteurs.
  for (const [key, open] of [['bold', '**'], ['italic', '*'], ['underline', '__'], ['strike', '~~']]) {
    assert.match(html, new RegExp(`data-md="${key}" data-open="${open.replace(/\*/g, '\\*')}" data-close="${open.replace(/\*/g, '\\*')}"`));
  }
  assert.match(html, /selectionStart/);
  assert.match(html, /setSelectionRange/);
  // execCommand est obsolète : il ne doit pas être utilisé.
  assert.doesNotMatch(html, /execCommand/);
  // Ctrl+Entrée enregistre, Échap annule.
  assert.match(html, /event\.key === 'Enter' && \(event\.ctrlKey \|\| event\.metaKey\)/);
  assert.match(html, /event\.key === 'Escape'/);
  assert.match(html, /data-action="cancel"/);
});

test('an insertion point sits between the blocks, and posts the slot it was clicked at', () => {
  const html = renderView('documentation', { ...base, currentPath: '/documentation', blocks, isFormManager: true, error: null, notice: null });

  // Un point par frontière : entre les blocs, puis après le dernier (sans
  // doublon tout en bas).
  assert.equal(html.match(/data-insert(?=[ >])/g)?.length, blocks.length);
  // `at` est le nombre de blocs au-dessus du point : 1, 2, 3… jusqu'à la fin.
  assert.deepEqual(
    [...html.matchAll(/name="at" value="(\d+)"/g)].map((match) => Number(match[1])),
    [1, 2, 3, 4, 5],
  );
  assert.equal(html.match(/class="doc-insert-btn"/g)?.length, blocks.length);
  assert.equal(html.match(/action="\/documentation\/blocs" method="post" class="doc-insert-form"/g)?.length, blocks.length);
});

test('the insertion picker offers the five block types as compact choices', () => {
  const html = renderView('documentation', { ...base, currentPath: '/documentation', blocks, isFormManager: true, error: null, notice: null });

  for (const label of ['Titre', 'Texte', 'Lien', 'Liste', 'Séparateur']) {
    assert.match(html, new RegExp(`aria-label="${label}"`), `l'icône ${label} existe et est accessible`);
  }
  // Le type se choisit à l'insertion, et se corrige dans l'éditeur : les deux
  // kinds de formulaire sont pilotés de la même façon, cinq choix chacun.
  // Cinq formulaires d'édition, plus un par frontière entre blocs/après le dernier.
  const editForms = blocks.length;
  const insertForms = blocks.length;
  assert.equal(html.match(/<form[^>]*data-typed-form/g)?.length, editForms + insertForms);
  assert.equal(html.match(/<button type="button" data-type=/g)?.length, (editForms + insertForms) * 5);
  // Clicking + reveals only the compact type choices. The details and submit
  // button remain hidden until the user chooses one of the five types.
  assert.equal(html.match(/class="doc-insert-fields" data-insert-details hidden/g)?.length, insertForms);
  assert.match(html, /var firstChoice = form\.querySelector\('\[data-type-picker\] button'\)/);

  // Chaque formulaire garde son <select name="block_type">, seule source de vérité
  // sans JavaScript : ceux d'édition sont pré-positionnés sur le type du bloc.
  assert.equal(html.match(/<select[^>]*name="block_type"/g)?.length, editForms + insertForms);
  for (const block of blocks) {
    const form = html.match(new RegExp(`<form class="doc-edit" action="/documentation/blocs/${block.id}"[\\s\\S]*?</form>`))?.[0] || '';
    assert.match(form, new RegExp(`<option value="${block.type}" selected>`), `le bloc ${block.id} reste de type ${block.type}`);
    assert.match(form, new RegExp(`<button type="button" data-type="${block.type}" aria-label="[^"]+" aria-pressed="true"`), `le bloc ${block.id} a son type coché`);
  }
  // Un séparateur n'a rien à remplir : il part dès qu'on le choisit.
  assert.match(html, /if \(!fields\.length\) \{\s*form\.submit\(\);/);
});

test('drag and drop stays the only reordering method when JavaScript is on', () => {
  const html = renderView('documentation', { ...base, currentPath: '/documentation', blocks, isFormManager: true, error: null, notice: null });

  assert.match(html, /action="\/documentation\/blocs\/reordonner"/);
  assert.match(html, /id="doc-reorder-form"/);
  assert.match(html, /input\.name = 'block_id'/);
  assert.match(html, /reorderForm\.submit\(\)/);
  assert.equal(html.match(/reorderForm\.submit\(\)/g)?.length, 1);
  assert.match(html, /dragstart/);

  // Les boutons ▲▼ ne survivent que dans le repli sans JavaScript, donc jamais
  // dans le DOM quand le script est actif.
  const noscript = html.match(/<noscript>[\s\S]*?<\/noscript>/)?.[0] || '';
  assert.match(noscript, /\/documentation\/blocs\/1\/deplacer/);
  assert.equal((noscript.match(/\/deplacer/g) || []).length, blocks.length * 2);
  const outsideNoscript = html.replace(/<noscript>[\s\S]*?<\/noscript>/, '');
  assert.doesNotMatch(outsideNoscript, /deplacer/);
});

test('an empty documentation invites the manager to insert the first block', () => {
  const html = renderView('documentation', { ...base, currentPath: '/documentation', blocks: [], isFormManager: true, error: null, notice: null });

  assert.match(html, /La documentation est vide/);
  // Le point d'insertion reste disponible : il est le seul point de départ.
  assert.equal(html.match(/data-insert(?=[ >])/g)?.length, 1);
  assert.match(html, /name="at" value="0"/);
  assert.equal(html.match(/class="empty-state"/g)?.length, 1);
});

test('a reader without the forms role gets no editing affordance at all', () => {
  const asReader = renderView('documentation', { ...base, currentPath: '/documentation', blocks, isFormManager: false, error: null, notice: null });

  assert.doesNotMatch(asReader, /class="doc-edit"/);
  assert.doesNotMatch(asReader, /data-insert/);
  assert.doesNotMatch(asReader, /doc-reorder-form/);
  assert.doesNotMatch(asReader, /data-confirm="Supprimer ce bloc/);
  assert.doesNotMatch(asReader, /deplacer|supprimer|reordonner/);
  assert.doesNotMatch(asReader, /draggable="true"/);
  assert.doesNotMatch(asReader, /doc-md-toolbar/);
  assert.doesNotMatch(asReader, /<script>/);
  // Le contenu publié, lui, reste complet.
  assert.match(asReader, /<h2 class="doc-heading">Règlement<\/h2>/);
  assert.match(asReader, /<li>a<\/li>/);
  assert.match(asReader, /<hr class="doc-separator">/);

  // Une page vide reste lisible, sans point d'insertion.
  const emptyReader = renderView('documentation', { ...base, currentPath: '/documentation', blocks: [], isFormManager: false, error: null, notice: null });
  assert.doesNotMatch(emptyReader, /data-insert/);
  assert.match(emptyReader, /Aucun contenu n/);
});

test('the footer links out to Discord and Roblox', () => {
  const html = renderPage('documentation', { ...base, currentPath: '/documentation', blocks, isFormManager: false, error: null, notice: null });

  assert.match(html, /<a href="https:\/\/discord\.gg\/svdpdNdnAB" target="_blank" rel="noopener noreferrer">Discord<\/a>/);
  // Le lien Roblox est un placeholder : le TODO doit survivre dans la vue.
  // Un commentaire EJS disparaît au rendu, on le cherche donc dans le source.
  assert.match(layout, /<%# TODO: remplacer par l'URL du groupe Roblox %>/);
  assert.match(html, /<a href="#" target="_blank" rel="noopener noreferrer">Roblox<\/a>/);
  // Les deux liens suivent les liens légaux, pas avant.
  assert.ok(html.indexOf('/privacy') < html.indexOf('discord.gg/svdpdNdnAB'));
});

test('the dashboard greeting carries the name for the client-side script', () => {
  const html = renderPage('dashboard', { ...base, currentPath: '/', isConnected: true, roblox: null });

  assert.match(html, /id="dashboard-greeting" data-name="Alice"/);
  // Le rendu serveur reste un repli, et le tranche horaire est calculée chez le visiteur.
  assert.match(html, /Bonjour, Alice/);
  assert.match(html, /new Date\(\)\.getHours\(\)/);
  assert.match(html, /BRACKETS/);

  // La page d'accueil déconnectée n'a pas d'accueil à personalised.
  const loggedOut = renderPage('dashboard', { ...base, currentPath: '/', isConnected: false, roblox: null });
  assert.doesNotMatch(loggedOut, /id="dashboard-greeting"/);
});
