import './helpers/env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import ejs from 'ejs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderDiscordMarkdown } from '../src/utils/discord-markdown.js';
import { webConfig } from '../src/config.js';

const viewsDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'views');
const layout = fs.readFileSync(path.join(viewsDir, 'layout.ejs'), 'utf8');

const base = {
  currentUser: { username: 'alice', globalName: 'Alice', avatarUrl: null },
  currentPath: '/candidatures',
  isStaff: false,
  isFormManager: true,
  webConfig: { documentationEnabled: true, discordUrl: webConfig.discordUrl },
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

// Mirrors what `documentationCards()` in routes/documentation.js hands to the view.
const docCards = [
  { key: 'ethics', title: 'Charte éthique', description: 'Texte normatif suprême.', url: 'https://docs.example.test/charte-ethique' },
  { key: 'facility', title: 'Charte de l’installation', description: 'Ce qui est acceptable dans l’installation.', url: 'https://docs.example.test/charte-installation' },
  { key: 'discord', title: 'Discord', description: 'Serveur Discord de la Fondation.', url: 'https://discord.gg/test-invitation' },
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
  'documentation': ['documentation', { currentPath: '/documentation', cards: docCards }],
  'documentation (Discord non configuré)': ['documentation', {
    currentPath: '/documentation', cards: docCards.map((card) => (card.key === 'discord' ? { ...card, url: '' } : card)),
  }],
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

test('layout exposes Candidatures to everyone and Réponses only to the forms role', () => {
  const listData = { forms: [form], ownForms: [], submittedFormIds: new Set(), justSubmitted: false };
  const asReader = renderPage('forms', { ...base, ...listData, isFormManager: false });
  assert.match(asReader, /href="\/candidatures"/);
  // /documentation reste accessible par son URL, mais n'est plus un onglet :
  // la page est autonome et publique.
  const nav = asReader.match(/<div class="nav-tabs"[\s\S]*?<\/div>/)?.[0] || '';
  assert.doesNotMatch(nav, /Documentation/);
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

test('the documentation page renders its three cards, and nothing else', () => {
  const html = renderView('documentation', { ...base, currentPath: '/documentation', cards: docCards });

  assert.equal(html.match(/class="card shortcut"/g)?.length, docCards.length);
  for (const card of docCards) {
    assert.ok(html.includes(card.title), `la carte « ${card.title} » a son titre`);
    assert.ok(html.includes(card.description), `la carte « ${card.title} » est décrite`);

    // Chaque lien part dans un nouvel onglet, sans jamais donner la main à
    // la page ouverte.
    assert.ok(
      html.includes(`href="${card.url}" target="_blank" rel="noopener noreferrer"`),
      `la carte « ${card.title} » ouvre son URL`,
    );
  }
  // Ni contenu stocké, ni chrome d'éditeur : la page est une simple table de liens.
  assert.doesNotMatch(html, /<form|<textarea|<select|documentation\/blocs|data-block-id/);
  assert.doesNotMatch(html, /<script/);
});

test('a card without a configured URL stops being a link', () => {
  const cards = docCards.map((card) => (card.key === 'discord' ? { ...card, url: '' } : card));
  const html = renderView('documentation', { ...base, currentPath: '/documentation', cards });

  assert.match(html, /<a class="card shortcut" aria-disabled="true">[\s\S]*?Discord/);
  assert.doesNotMatch(html, /<a class="card shortcut"[^>]*href="#"[^>]*aria-disabled/);
  // Les deux cartes configurées restent, elles, cliquables.
  assert.equal(html.match(/target="_blank"/g)?.length, 2);
});

test('the footer links out to Discord and Roblox, from the server configuration', () => {
  const html = renderPage('documentation', { ...base, currentPath: '/documentation', cards: docCards });

  // Une seule source d'URL Discord : celle de la configuration, pas une adresse
  // écrite en dur dans la vue.
  assert.match(layout, /<a href="<%= webConfig\?\.discordUrl \|\| '#' %>" target="_blank" rel="noopener noreferrer">Discord<\/a>/);
  assert.ok(html.includes(`<a href="${webConfig.discordUrl}" target="_blank" rel="noopener noreferrer">Discord</a>`));
  // Le lien Roblox est un placeholder : le TODO doit survivre dans la vue.
  // Un commentaire EJS disparaît au rendu, on le cherche donc dans le source.
  assert.match(layout, /<%# TODO: remplacer par l'URL du groupe Roblox %>/);
  assert.match(html, /<a href="#" target="_blank" rel="noopener noreferrer">Roblox<\/a>/);
  // Les deux liens suivent les liens légaux, pas avant. La carte Discord partage
  // la même URL : c'est sa dernière occurrence, celle du footer, qu'on compare.
  assert.ok(html.indexOf('/privacy') < html.lastIndexOf(`href="${webConfig.discordUrl}" target="_blank"`));

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
