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

const blocks = [
  { id: 1, type: 'heading', typeLabel: 'Titre', title: 'Règlement', content: '', url: '', items: [], preview: 'Règlement' },
  { id: 2, type: 'text', typeLabel: 'Texte', title: '', content: 'Texte', url: '', items: [], preview: 'Texte' },
  { id: 3, type: 'link', typeLabel: 'Lien', title: 'Discord', content: '', url: 'https://discord.com', items: [], preview: 'Discord' },
  { id: 4, type: 'bullets', typeLabel: 'Liste à puces', title: '', content: 'a\nb', url: '', items: ['a', 'b'], preview: 'a · b' },
];

/** Renders a view inside the real layout, the way `server.js` does. */
function renderPage(view, data) {
  const filename = path.join(viewsDir, `${view}.ejs`);
  const body = ejs.render(fs.readFileSync(filename, 'utf8'), data, { filename });
  return ejs.render(layout, { ...data, body }, { filename: path.join(viewsDir, 'layout.ejs') });
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
  const asReader = renderPage('documentation', { ...base, currentPath: '/documentation', blocks, isFormManager: false, error: null, notice: null });
  assert.doesNotMatch(asReader, /Ajouter un bloc/);
  assert.doesNotMatch(asReader, /\/documentation\/blocs/);
  // The published content stays visible.
  assert.match(asReader, /Règlement/);
});
