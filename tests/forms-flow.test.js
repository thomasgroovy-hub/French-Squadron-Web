/**
 * Vérifie qu'un formulaire Coordinateur06 / Staff FSU peut réellement
 * remplir, envoyer puis être traité de bout en bout : c'est le trajet que les
 * trois bugs signalés rendaient impossible.
 */
import './helpers/env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { sealSession } from '../src/auth/session.js';
import { createApp } from '../src/server.js';
import { webConfig } from '../src/config.js';
import { createFakePool } from './helpers/fake-mysql.js';

const FORMS_ROLE = '1532037579816570981';
const cookie = (user) => `${webConfig.cookieName}=${sealSession({ user }, webConfig.sessionSecret)}`;

const RECRUITER = { id: 'recruiter-1', username: 'Coordinateur06', globalName: 'Coordinateur06', avatarUrl: null };
const CANDIDATE = { id: 'candidate-1', username: 'Pilote', globalName: 'Pilote', avatarUrl: null };

const fetchFn = async (url, options = {}) => {
  if (url.endsWith('/roles') && !options.method) {
    return { ok: true, status: 200, json: async () => [{ id: FORMS_ROLE, name: 'Recruteurs' }] };
  }
  if (/\/guilds\/[^/]+\/members\/[^/]+$/.test(url)) {
    const id = url.split('/').pop();
    const roles = id === CANDIDATE.id ? [] : [FORMS_ROLE];
    return { ok: true, status: 200, json: async () => ({ roles }) };
  }
  if (/\/channels\/[^/]+\/messages$/.test(url)) {
    return { ok: true, status: 200, json: async () => ({ id: 'msg-1' }) };
  }
  return { ok: false, status: 404, json: async () => ({}) };
};

function encode(body) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(body)) {
    for (const item of Array.isArray(value) ? value : [value]) params.append(key, String(item ?? ''));
  }
  return params.toString();
}

async function startApp() {
  const pool = createFakePool();
  const server = http.createServer(createApp({ pool, fetchFn }));
  await new Promise((resolve) => server.listen(0, resolve));
  const { port } = server.address();

  const call = (path, as, init = {}) => fetch(`http://localhost:${port}${path}`, {
    ...init,
    headers: { Cookie: cookie(as), ...(init.headers || {}) },
    redirect: 'manual',
  });
  const post = (path, body, as = RECRUITER) => call(path, as, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: encode(body),
  });

  return { pool, get: (p, as = RECRUITER) => call(p, as), post, close: () => server.close() };
}

test('parcours complet : créer, publier, remplir, puis accepter une candidature', async () => {
  const app = await startApp();
  try {
    // 1. Création avec deux questions.
    const created = await app.post('/candidatures', {
      title: 'Recrutement pilote FSU',
      description: 'Poste de pilote sur la ligne French Squadron.',
      granted_role_id: '',
      'question_id[]': ['', ''],
      'question_label[]': ['Pourquoi rejoignez-vous la FSU ?', 'Disponibilités weekly'],
      'question_type[]': ['long', 'short'],
      'question_help[]': ['Quelques lignes suffisent.', ''],
    });
    assert.equal(created.status, 302);
    const formId = app.pool.store.forms[0].id;
    const questions = app.pool.questionsOf(formId);
    assert.equal(questions.length, 2);
    assert.deepEqual(questions.map((q) => q.field_type), ['long', 'short']);

    // 2. Publication.
    const published = await app.post(`/candidatures/${formId}/publier`, {});
    assert.equal(published.status, 302, 'la publication ne doit pas être bloquée');
    assert.equal(app.pool.store.forms[0].status, 'open');

    // 3. Le candidat voit le formulaire et répond. Les réponses sont nommées
    // d'après l'id de la question, qui doit survivre aux enregistrements.
    const fill = await app.get(`/candidatures/${formId}`, CANDIDATE);
    assert.equal(fill.status, 200);
    const fillHtml = await fill.text();
    assert.match(fillHtml, /Pourquoi rejoignez-vous la FSU/);
    assert.match(fillHtml, new RegExp(`name="answer_${questions[0].id}"`));

    const submitted = await app.post(`/candidatures/${formId}/reponses`, {
      [`answer_${questions[0].id}`]: 'Parce que la FS2 me passionne.',
      [`answer_${questions[1].id}`]: 'Mardi et jeudi soir.',
    }, CANDIDATE);
    assert.equal(submitted.status, 302);
    assert.match(submitted.headers.get('location'), /envoyee=1/);

    const responses = app.pool.store.formResponses;
    assert.equal(responses.length, 1, 'la candidature est enregistrée');
    assert.equal(responses[0].status, 'pending');
    const answers = JSON.parse(responses[0].answers);
    assert.equal(answers[String(questions[0].id)], 'Parce que la FS2 me passionne.');

    // 4. Tant qu'elle est en attente, une seconde soumission est refusée.
    const duplicate = await app.post(`/candidatures/${formId}/reponses`, {
      [`answer_${questions[0].id}`]: 'Tentative 2',
      [`answer_${questions[1].id}`]: 'Tentative 2',
    }, CANDIDATE);
    assert.equal(duplicate.status, 409, 'la candidature en attente est signalée');
    assert.equal(app.pool.store.formResponses.length, 1, 'aucun doublon créé');

    // 5. Le recruteur voit la candidature et l'accepte.
    const inbox = await app.get('/reponses');
    assert.equal(inbox.status, 200);
    const inboxHtml = await inbox.text();
    assert.match(inboxHtml, /Recrutement pilote FSU/);
    assert.match(inboxHtml, /Coordinateur06|FS2 me passionne|Pilote/);

    // 6. Le recruteur accepte : la page de détail est réaffichée avec une
    // confirmation, et le statut passe bien à "accepted".
    const responseId = responses[0].id;
    const accepted = await app.post(`/reponses/${responseId}/accepter`, {});
    assert.equal(accepted.status, 200);
    const acceptedHtml = await accepted.text();
    assert.match(acceptedHtml, /Candidature acceptée/);
    assert.equal(app.pool.store.formResponses[0].status, 'accepted');

    // Un second clic ne réaccorde pas le rôle une deuxième fois.
    const replay = await app.post(`/reponses/${responseId}/accepter`, {});
    assert.equal(replay.status, 409, 'une candidature déjà traitée est refusée');
    assert.equal(app.pool.store.formResponses.length, 1);
  } finally {
    app.close();
  }
});

test('un membre sans le rôle formulaires ne peut ni créer ni gérer de formulaire', async () => {
  const app = await startApp();
  try {
    const res = await app.get('/candidatures/nouveau', CANDIDATE);
    assert.equal(res.status, 403, 'le rôle formulaires est exigé');

    const created = await app.post('/candidatures', { title: 'Pirate' }, CANDIDATE);
    assert.equal(created.status, 403);
    assert.equal(app.pool.store.forms.length, 0, 'aucun formulaire créé');
  } finally {
    app.close();
  }
});
