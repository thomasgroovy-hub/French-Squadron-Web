/**
 * Regression tests for the reported bugs, exercised through the real Express
 * routes against a stateful MySQL double.
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

const MANAGER = { id: 'manager-1', username: 'Recruteur', globalName: 'Chef Recruteur', avatarUrl: null };

const cookie = (user) => `${webConfig.cookieName}=${sealSession({ user }, webConfig.sessionSecret)}`;

const discord = (roles = [FORMS_ROLE]) => async (url, options = {}) => {
  if (url.endsWith('/roles') && !options.method) {
    return { ok: true, status: 200, json: async () => roles.map((id) => ({ id, name: `Role-${id}` })) };
  }
  if (/\/guilds\/[^/]+\/members\/[^/]+$/.test(url)) {
    return { ok: true, status: 200, json: async () => ({ roles }) };
  }
  if (/\/channels\/[^/]+\/messages$/.test(url)) {
    return { ok: true, status: 200, json: async () => ({ id: 'msg-1' }) };
  }
  return { ok: false, status: 404, json: async () => ({}) };
};

// Arrays must become repeated keys (`question_label[]=a&question_label[]=b`);
// `new URLSearchParams({ x: ['a', 'b'] })` would join them with a comma instead.
function encode(body) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(body)) {
    for (const item of Array.isArray(value) ? value : [value]) {
      params.append(key, String(item ?? ''));
    }
  }
  return params.toString();
}

async function startApp({ pool, fetchFn = discord() }) {
  const server = http.createServer(createApp({ pool, fetchFn }));
  await new Promise((resolve) => server.listen(0, resolve));
  const port = server.address().port;
  return {
    pool,
    get: (path) => fetch(`http://localhost:${port}${path}`, { headers: { Cookie: cookie(MANAGER) }, redirect: 'manual' }),
    post: (path, body) => fetch(`http://localhost:${port}${path}`, {
      method: 'POST',
      headers: { Cookie: cookie(MANAGER), 'Content-Type': 'application/x-www-form-urlencoded' },
      body: encode(body),
      redirect: 'manual',
    }),
    close: () => server.close(),
  };
}

const countQuestionInputs = (html) => (html.match(/name="question_label\[\]"/g) || []).length;

test('BUG 1: the new-form page offers a question row to fill in', async () => {
  const app = await startApp({ pool: createFakePool() });
  try {
    const res = await app.get('/candidatures/nouveau');
    const html = await res.text();

    assert.equal(res.status, 200);
    assert.match(html, /Ajouter une question/);
    assert.equal(countQuestionInputs(html), 1, 'a brand-new form starts with one fillable question row');
  } finally {
    app.close();
  }
});

test('BUG 1: "Ajouter une question" works before the form exists', async () => {
  const pool = createFakePool();
  const app = await startApp({ pool });
  try {
    const res = await app.post('/candidatures', {
      action: 'add_question',
      title: 'Recrutement pilote',
      description: '',
      granted_role_id: '',
      'question_id[]': [''],
      'question_label[]': [''],
      'question_type[]': ['short'],
      'question_help[]': [''],
    });
    const html = await res.text();

    assert.equal(res.status, 200);
    assert.equal(countQuestionInputs(html), 2, 'the second row is rendered');
    assert.match(html, /Question ajoutée/);
    assert.equal(pool.store.forms.length, 0, 'nothing is persisted before the form is saved');
  } finally {
    app.close();
  }
});

test('BUG 1: a form with questions can be created', async () => {
  const pool = createFakePool();
  const app = await startApp({ pool });
  try {
    const res = await app.post('/candidatures', {
      title: 'Recrutement pilote',
      'question_id[]': ['', ''],
      'question_label[]': ['Pourquoi souhaitez-vous rejoindre l’équipe ?', 'Présentation'],
      'question_type[]': ['long', 'short'],
      'question_help[]': ['Quelques lignes suffisent.', ''],
    });

    assert.equal(res.status, 302, 'the create route no longer throws ReferenceError: createForm');
    const formId = pool.store.forms[0].id;
    assert.equal(res.headers.get('location'), `/candidatures/${formId}`);

    const questions = pool.questionsOf(formId);
    assert.equal(questions.length, 2);
    assert.deepEqual(questions.map((q) => q.label), [
      'Pourquoi souhaitez-vous rejoindre l’équipe ?',
      'Présentation',
    ]);
    assert.deepEqual(questions.map((q) => q.field_type), ['long', 'short']);
    assert.equal(questions[0].help_text, 'Quelques lignes suffisent.');
  } finally {
    app.close();
  }
});

test('BUG 1: blank question rows do not block a save', async () => {
  const pool = createFakePool();
  const app = await startApp({ pool });
  try {
    const res = await app.post('/candidatures', {
      title: 'Recrutement pilote',
      'question_id[]': ['', ''],
      'question_label[]': ['Seule question valide', ''],
      'question_type[]': ['short', 'short'],
      'question_help[]': ['', ''],
    });

    assert.equal(res.status, 302);
    assert.equal(pool.questionsOf(pool.store.forms[0].id).length, 1);
  } finally {
    app.close();
  }
});

test('BUG 1: the reorder buttons move a question the way they are labelled', async () => {
  const pool = createFakePool();
  const app = await startApp({ pool });
  try {
    const res = await app.post('/candidatures', {
      title: 'Recrutement pilote',
      'question_id[]': ['', '', ''],
      'question_label[]': ['A', 'B', 'C'],
      'question_type[]': ['short', 'short', 'short'],
      'question_help[]': ['', '', ''],
    });
    assert.equal(res.status, 302);
    const formId = pool.store.forms[0].id;
    const [a, b, c] = pool.questionsOf(formId);

    const base = {
      title: 'Recrutement pilote',
      'question_type[]': ['short', 'short', 'short'],
      'question_help[]': ['', '', ''],
    };
    const rows = (order, move) => ({
      ...base,
      'question_id[]': order.map((q) => String(q.id)),
      'question_label[]': order.map((q) => q.label),
      ...(move ? { move } : {}),
    });

    await app.post(`/candidatures/${formId}`, rows([b, a, c], `up:${b.id}`));
    assert.deepEqual(pool.questionsOf(formId).map((q) => q.id), [b.id, a.id, c.id]);

    await app.post(`/candidatures/${formId}`, rows([b, a, c], `down:${b.id}`));
    assert.deepEqual(pool.questionsOf(formId).map((q) => q.id), [a.id, b.id, c.id]);

    // The order survives a round trip, and the labels follow their question.
    const html = await (await app.get(`/candidatures/${formId}`)).text();
    const rendered = [...html.matchAll(/name="question_label\[\]" value="([^"]*)"/g)].map((m) => m[1]);
    assert.deepEqual(rendered, ['A', 'B', 'C']);
  } finally {
    app.close();
  }
});

test('BUG 1: adding a question on an existing form reports success and refreshes the list', async () => {
  const pool = createFakePool();
  const app = await startApp({ pool });
  try {
    await app.post('/candidatures', {
      title: 'Recrutement pilote',
      'question_id[]': [''],
      'question_label[]': ['Première'],
      'question_type[]': ['short'],
      'question_help[]': [''],
    });
    const formId = pool.store.forms[0].id;

    const res = await app.post(`/candidatures/${formId}`, {
      action: 'add_question',
      title: 'Recrutement pilote',
      'question_id[]': [String(pool.questionsOf(formId)[0].id)],
      'question_label[]': ['Première'],
      'question_type[]': ['short'],
      'question_help[]': [''],
    });

    assert.equal(res.status, 302);
    assert.match(res.headers.get('location'), /enregistre=Question%20ajout%C3%A9e/);

    const html = await (await app.get(res.headers.get('location'))).text();
    assert.equal(countQuestionInputs(html), 2);
    assert.match(html, /Question ajoutée/);
  } finally {
    app.close();
  }
});

test('BUG 2: a documentation link block round-trips through the database', async () => {
  const pool = createFakePool();
  const app = await startApp({ pool });
  try {
    const res = await app.post('/documentation/blocs', {
      block_type: 'link',
      title: 'Règlement',
      content: '',
      url: 'https://discord.com/channels/1487258655840669807/123456',
    });
    assert.equal(res.status, 302);
    assert.match(res.headers.get('location'), /^\/documentation\?info=/);

    const stored = pool.store.documentationBlocks[0];
    assert.equal(stored.block_type, 'link');
    assert.equal(stored.title, 'Règlement');
    assert.equal(stored.url, 'https://discord.com/channels/1487258655840669807/123456');

    const html = await (await app.get('/documentation')).text();
    const href = /class="doc-link" href="([^"]*)"/.exec(html);
    assert.ok(href, 'the link block is rendered');
    assert.equal(
      href[1],
      'https://discord.com/channels/1487258655840669807/123456',
      'the href must be the stored absolute URL',
    );
    assert.doesNotMatch(html, /href="\/channels/, 'the URL must not be turned into a relative path');
  } finally {
    app.close();
  }
});

test('BUG 2: an empty or non-http URL is refused and nothing is stored', async () => {
  const pool = createFakePool();
  const app = await startApp({ pool });
  try {
    for (const url of ['', 'javascript:alert(1)', 'discord.com/salon']) {
      const res = await app.post('/documentation/blocs', { block_type: 'link', title: 'Règlement', url });
      assert.equal(res.status, 302);
      assert.match(res.headers.get('location'), /erreur=/, `"${url}" must be rejected`);
    }
    assert.equal(pool.store.documentationBlocks.length, 0, 'nothing invalid is stored');
  } finally {
    app.close();
  }
});

test('BUG 3: the decorative hero ring only exists on the dashboard', async () => {
  const pool = createFakePool();
  const app = await startApp({ pool });
  try {
    const dashboard = await (await app.get('/')).text();
    assert.match(dashboard, /dashboard-hero/, 'the dashboard owns the hero');

    for (const path of ['/candidatures', '/documentation', '/reponses', '/profil']) {
      const html = await (await app.get(path)).text();
      assert.doesNotMatch(html, /class="[^"]*dashboard-hero/, `${path} must not render the hero`);
    }
  } finally {
    app.close();
  }
});
