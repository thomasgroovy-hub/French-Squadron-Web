/**
 * Vérifie qu'un formulaire Coordinateur06 / Staff FSU peut réellement
 * remplir, envoyer puis être traité de bout en bout : c'est le trajet que les
 * trois bugs signalés rendaient impossible.
 */
import './helpers/env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { sealSession, unsealSession } from '../src/auth/session.js';
import { deriveCsrfToken } from '../src/security/csrf.js';
import { createApp } from '../src/server.js';
import { webConfig } from '../src/config.js';
import { createFakePool } from './helpers/fake-mysql.js';

const FORMS_ROLE = '1532037579816570981';
const auth = (user) => {
  const sealed = sealSession({ user }, webConfig.sessionSecret);
  return {
    cookie: `${webConfig.cookieName}=${sealed}`,
    csrf: deriveCsrfToken(unsealSession(sealed), webConfig.sessionSecret),
  };
};

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

async function startApp({ rankConfig = null, withRobloxLink = false } = {}) {
  const pool = createFakePool();
  const sitePool = withRobloxLink ? createFakePool() : null;
  if (sitePool) {
    sitePool.store.robloxLinks.push({
      discord_user_id: CANDIDATE.id,
      roblox_user_id: '420010',
      roblox_username: 'Pilote',
    });
  }
  const robloxRequests = [];
  const robloxAssignments = [];
  const routedFetch = async (url, options = {}) => {
    const requestUrl = String(url);
    if (requestUrl.startsWith('https://apis.roblox.com/cloud/v2/')) {
      const parsed = new URL(requestUrl);
      robloxRequests.push({ url: parsed, options });
      if (parsed.pathname.endsWith('/roles')) {
        return { ok: true, status: 200, json: async () => ({
          groupRoles: [{ id: '420001', displayName: 'Pilote' }],
        }) };
      }
      if (parsed.pathname.endsWith('/memberships')) {
        return { ok: true, status: 200, json: async () => ({
          groupMemberships: [{
            path: 'groups/420100/memberships/420020',
            user: 'users/420010',
            role: 'groups/420100/roles/1',
          }],
        }) };
      }
      if (parsed.pathname.endsWith(':assignRole')) {
        robloxAssignments.push({ url: parsed, options });
        return { ok: true, status: 204, json: async () => null };
      }
    }
    if (requestUrl.startsWith('https://users.roblox.com/v1/users/')) {
      return { ok: true, status: 200, json: async () => ({ id: 420010, name: 'Pilote' }) };
    }
    return fetchFn(requestUrl, options);
  };
  const config = rankConfig ? { ...webConfig, ...rankConfig } : webConfig;
  const server = http.createServer(createApp({ pool, sitePool, fetchFn: routedFetch, config }));
  await new Promise((resolve) => server.listen(0, resolve));
  const { port } = server.address();

  const call = (path, as, init = {}) => fetch(`http://localhost:${port}${path}`, {
    ...init,
    headers: { Cookie: auth(as).cookie, ...(init.headers || {}) },
    redirect: 'manual',
  });
  const post = (path, body, as = RECRUITER) => {
    // One seal for both artifacts: the token is derived from the payload, so
    // the cookie and `_csrf` must come from the very same seal.
    const { cookie: ck, csrf } = auth(as);
    const params = encode(body);
    return fetch(`http://localhost:${port}${path}`, {
      method: 'POST',
      headers: { Cookie: ck, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params ? `${params}&_csrf=${encodeURIComponent(csrf)}` : `_csrf=${encodeURIComponent(csrf)}`,
      redirect: 'manual',
    });
  };

  return {
    pool,
    sitePool,
    robloxRequests,
    robloxAssignments,
    get: (p, as = RECRUITER) => call(p, as),
    post,
    close: () => server.close(),
  };
}

async function createPublishedForm(app, { requiredRoleId = '' } = {}) {
  const created = await app.post('/candidatures', {
    title: 'Recrutement pilote FSU',
    description: 'Poste de pilote.',
    granted_role_id: '',
    required_role_id: requiredRoleId,
    'question_id[]': [''],
    'question_label[]': ['Pourquoi rejoignez-vous la FSU ?'],
    'question_type[]': ['short'],
    'question_help[]': [''],
  });
  assert.equal(created.status, 302);
  const formId = app.pool.store.forms.at(-1).id;
  const questionId = app.pool.questionsOf(formId)[0].id;
  const published = await app.post(`/candidatures/${formId}/publier`, {});
  assert.equal(published.status, 302);
  return { formId, questionId };
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
    assert.equal(answers._robloxGroupRoleId, undefined, 'an omitted optional rank remains backward compatible');

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

    // 7. Une candidature acceptée est définitive : le membre ne peut plus
    // répondre à ce formulaire, même si sa candidature n'est plus "pending".
    const blockedForm = await app.get(`/candidatures/${formId}`, CANDIDATE);
    assert.equal(blockedForm.status, 200);
    const blockedHtml = await blockedForm.text();
    assert.match(blockedHtml, /a été acceptée sur ce formulaire/);
    assert.doesNotMatch(blockedHtml, new RegExp(`name="answer_${questions[0].id}"`), 'le formulaire ne doit plus être rendu');

    const blockedSubmit = await app.post(`/candidatures/${formId}/reponses`, {
      [`answer_${questions[0].id}`]: 'Je confirme ma candidature',
      [`answer_${questions[1].id}`]: 'Encore disponible',
    }, CANDIDATE);
    assert.equal(blockedSubmit.status, 409, 'une candidature acceptée bloque la soumission');
    assert.equal(app.pool.store.formResponses.length, 1, 'aucune candidature créée après acceptation');

    const blockedList = await app.get('/candidatures', CANDIDATE);
    assert.equal(blockedList.status, 200);
    const listHtml = await blockedList.text();
    assert.match(listHtml, /Acceptée/);
    assert.doesNotMatch(listHtml, new RegExp(`href="/candidatures/${formId}"`), 'le bouton Postuler a disparu');

    // Le blocage est propre au candidat : le recruteur, qui n'est pas
    // applicant, continue de voir le formulaire et son lien.
    const managerList = await app.get('/candidatures', RECRUITER);
    assert.equal(managerList.status, 200);
    const managerHtml = await managerList.text();
    assert.match(managerHtml, /Recrutement pilote FSU/);
    assert.match(managerHtml, new RegExp(`href="/candidatures/${formId}"`));
  } finally {
    app.close();
  }
});

test('a valid optional rank is stored at submission and applied only after an authorized acceptance', async () => {
  const app = await startApp({
    withRobloxLink: true,
    rankConfig: {
      robloxGroupId: '420100',
      robloxOpenCloudApiKey: 'mock-open-cloud-key',
      robloxRequestableRoleIds: ['420001'],
    },
  });
  try {
    const { formId, questionId } = await createPublishedForm(app);
    const fill = await app.get(`/candidatures/${formId}`, CANDIDATE);
    assert.equal(fill.status, 200);
    const fillHtml = await fill.text();
    assert.match(fillHtml, /Quel rank donner sur le groupe \?/);
    assert.match(fillHtml, /<option value="420001"[^>]*>Pilote<\/option>/);

    const submitted = await app.post(`/candidatures/${formId}/reponses`, {
      [`answer_${questionId}`]: 'Je souhaite rejoindre le groupe.',
      _robloxGroupRoleId: '420001',
    }, CANDIDATE);
    assert.equal(submitted.status, 302);
    const response = app.pool.store.formResponses[0];
    assert.equal(JSON.parse(response.answers)._robloxGroupRoleId, '420001');
    assert.equal(app.robloxAssignments.length, 0, 'a request alone must not change the Roblox role');

    const unauthorizedApproval = await app.post(`/reponses/${response.id}/accepter`, {}, CANDIDATE);
    assert.equal(unauthorizedApproval.status, 403);
    assert.equal(response.status, 'pending');
    assert.equal(app.robloxAssignments.length, 0);

    const accepted = await app.post(`/reponses/${response.id}/accepter`, {});
    assert.equal(accepted.status, 200);
    assert.equal(response.status, 'accepted');
    assert.equal(app.robloxAssignments.length, 1);
    assert.equal(app.robloxAssignments[0].options.method, 'POST');
    assert.deepEqual(JSON.parse(app.robloxAssignments[0].options.body), {
      role: 'groups/420100/roles/420001',
    });
    assert.match(await accepted.text(), /Rank Roblox/);

    const blankForm = await createPublishedForm(app);
    const blankSubmission = await app.post(`/candidatures/${blankForm.formId}/reponses`, {
      [`answer_${blankForm.questionId}`]: 'Je ne demande pas de rank.',
      _robloxGroupRoleId: '',
    }, CANDIDATE);
    assert.equal(blankSubmission.status, 302, 'the optional rank may remain blank with Open Cloud configured');
    const blankResponse = app.pool.store.formResponses[1];
    assert.equal(JSON.parse(blankResponse.answers)._robloxGroupRoleId, undefined);
    const blankAccepted = await app.post(`/reponses/${blankResponse.id}/accepter`, {});
    assert.equal(blankAccepted.status, 200);
    assert.equal(app.robloxAssignments.length, 1, 'blank requests do not invoke Roblox assignment');
  } finally {
    app.close();
  }
});

test('a forged Roblox role ID is rejected and an applicant without the form role cannot reach the rank field', async () => {
  const app = await startApp({
    withRobloxLink: true,
    rankConfig: {
      robloxGroupId: '420100',
      robloxOpenCloudApiKey: 'mock-open-cloud-key',
      robloxRequestableRoleIds: ['420001'],
    },
  });
  try {
    const { formId, questionId } = await createPublishedForm(app);
    const forged = await app.post(`/candidatures/${formId}/reponses`, {
      [`answer_${questionId}`]: 'Je souhaite rejoindre le groupe.',
      _robloxGroupRoleId: '420999',
    }, CANDIDATE);
    assert.equal(forged.status, 400);
    assert.match(await forged.text(), /ne fait pas partie des choix autorisés/);
    assert.equal(app.pool.store.formResponses.length, 0);
    assert.equal(app.robloxAssignments.length, 0);

    const restricted = await createPublishedForm(app, { requiredRoleId: FORMS_ROLE });
    const deniedView = await app.get(`/candidatures/${restricted.formId}`, CANDIDATE);
    assert.equal(deniedView.status, 403);
    const deniedPost = await app.post(`/candidatures/${restricted.formId}/reponses`, {
      [`answer_${restricted.questionId}`]: 'Tentative directe.',
      _robloxGroupRoleId: '420001',
    }, CANDIDATE);
    assert.equal(deniedPost.status, 403);
    assert.equal(app.pool.store.formResponses.length, 0);
    assert.equal(app.robloxAssignments.length, 0);
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
