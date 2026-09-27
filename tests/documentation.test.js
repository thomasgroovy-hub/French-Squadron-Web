import './helpers/env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { sealSession } from '../src/auth/session.js';
import { DOC_BLOCK_TYPES, ensureDocumentationTables, reorderDocumentationBlocks } from '../src/services/documentation.js';
import { createApp } from '../src/server.js';
import { webConfig } from '../src/config.js';
import { createFakePool } from './helpers/fake-mysql.js';

const FORMS_ROLE = '1532037579816570981';
const PILOT_ROLE = '1400000000000000001';

const MANAGER = { id: 'manager-1', username: 'Recruteur', globalName: 'Chef Recruteur', avatarUrl: null };
const READER = { id: 'reader-1', username: 'Pilote', globalName: 'Pilote', avatarUrl: null };
const PILOT = { id: 'pilot-1', username: 'Pilote', globalName: 'Pilote', avatarUrl: null };

/** Each user gets exactly the roles they really hold: the gate is the point here. */
const ROLES_BY_USER = {
  'manager-1': [FORMS_ROLE],
  'reader-1': [],
  'pilot-1': [PILOT_ROLE],
};

function cookieFor(user) {
  return `${webConfig.cookieName}=${sealSession({ user }, webConfig.sessionSecret)}`;
}

function memberFetch() {
  return async (url, options = {}) => {
    if (url.endsWith('/roles') && options.method === undefined) {
      const roles = [...new Set(Object.values(ROLES_BY_USER).flat())];
      return { ok: true, status: 200, json: async () => roles.map((id) => ({ id, name: `Role-${id}` })) };
    }
    const member = /\/guilds\/[^/]+\/members\/([^/]+)$/.exec(url);
    if (member) {
      return { ok: true, status: 200, json: async () => ({ roles: ROLES_BY_USER[member[1]] ?? [] }) };
    }
    if (/\/members\/[^/]+\/roles\/[^/]+$/.test(url)) {
      return { ok: true, status: 204, json: async () => ({}) };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };
}

async function startServer({ pool }) {
  const app = createApp({ pool, fetchFn: memberFetch() });
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  return { port: server.address().port, close: () => new Promise((resolve) => server.close(resolve)) };
}

/**
 * Builds an urlencoded body, repeating a key once per array value. `URLSearchParams`
 * would stringify an array into `a=1,2,3`, which is not what a form with several
 * fields of the same name actually sends.
 */
function formBody(fields) {
  const parts = [];
  for (const [name, value] of Object.entries(fields)) {
    for (const item of Array.isArray(value) ? value : [value]) {
      parts.push(`${encodeURIComponent(name)}=${encodeURIComponent(item)}`);
    }
  }
  return parts.join('&');
}

function post(port, path, fields, user = MANAGER) {
  return fetch(`http://localhost:${port}${path}`, {
    method: 'POST',
    headers: { Cookie: cookieFor(user), 'Content-Type': 'application/x-www-form-urlencoded' },
    body: formBody(fields),
    redirect: 'manual',
  });
}

/** Blocks sorted by position: exactly what the published order depends on. */
function published(pool) {
  return pool.store.documentationBlocks
    .slice()
    .sort((a, b) => a.position - b.position || a.id - b.id)
    .map((block) => [block.id, block.position]);
}

function withBlocks(count = 3) {
  const pool = createFakePool();
  pool.store.documentationBlocks = Array.from({ length: count }, (_, index) => ({
    id: index + 1,
    position: index,
    block_type: 'text',
    title: '',
    content: '',
    url: '',
  }));
  return pool;
}

// ------------------------------------------------------- reorderDocumentationBlocks

test('reorderDocumentationBlocks renumbers positions from 0, in the given order', async () => {
  const pool = withBlocks(3);

  const moved = await reorderDocumentationBlocks([3, 1, 2], pool);

  assert.equal(moved, true);
  assert.deepEqual(published(pool), [[3, 0], [1, 1], [2, 2]]);
});

test('reorderDocumentationBlocks numbers the payload, not the rows it managed to update', async () => {
  const pool = withBlocks(3);

  // Unknown ids are simply not rows; the payload still drives the numbering, so
  // the surviving blocks land one slot further down. The UI never hits this: the
  // hidden form is rebuilt from the cards actually on screen, and a drag can only
  // reorder existing blocks.
  await reorderDocumentationBlocks([999, 2, 1], pool);

  // Block 3 is not in the payload either, so it keeps position 2 — which block 1
  // just took. `ORDER BY position, id` still renders a stable, complete list.
  assert.deepEqual(published(pool), [[2, 1], [1, 2], [3, 2]]);
});

test('reorderDocumentationBlocks leaves out-of-band positions alone when they are not in the payload', async () => {
  const pool = withBlocks(3);

  // Block 1 is not part of the payload: it keeps position 0, which block 2 is
  // about to take too. Documented on purpose — the contract is "the payload is
  // the new order", not "repair whatever the caller left out".
  await reorderDocumentationBlocks([2, 3], pool);

  assert.deepEqual(published(pool), [[1, 0], [2, 0], [3, 1]]);
});

test('reorderDocumentationBlocks does nothing when the payload holds no usable id', async () => {
  const pool = withBlocks(1);
  pool.store.documentationBlocks[0].position = 3;

  assert.equal(await reorderDocumentationBlocks([], pool), false);
  assert.equal(await reorderDocumentationBlocks([undefined, null, 'abc', 0, -4], pool), false);
  assert.equal(await reorderDocumentationBlocks('not-an-array', pool), false);
  // Untouched: the gap stays, nothing was renumbered.
  assert.deepEqual(published(pool), [[1, 3]]);
});

// ------------------------------------------------------------------ bulk reorder route

test('the bulk reorder route saves a whole drag in a single request', async () => {
  const pool = withBlocks(3);
  const { port, close } = await startServer({ pool });

  const res = await post(port, '/documentation/blocs/reordonner', { block_id: ['3', '1', '2'] });

  assert.equal(res.status, 302);
  assert.equal(res.headers.get('location'), '/documentation');
  assert.deepEqual(published(pool), [[3, 0], [1, 1], [2, 2]]);
  await close();
});

test('the bulk reorder route is not swallowed by the block id route', async () => {
  const pool = withBlocks(2);
  const { port, close } = await startServer({ pool });

  // Express matches in order: were `/blocs/reordonner` declared after
  // `/blocs/:blockId`, "reordonner" would be read as a block id and this would
  // update a block named NaN instead of reordering the list.
  const res = await post(port, '/documentation/blocs/reordonner', { block_id: ['2', '1'] });

  assert.equal(res.status, 302);
  assert.deepEqual(published(pool), [[2, 0], [1, 1]]);
  await close();
});

test('the bulk reorder route accepts a single id without the array syntax', async () => {
  const pool = createFakePool();
  // Positions chosen far from 0 so the one id in the payload cannot collide with
  // the block it leaves out: this test is about the scalar branch, not the gaps.
  pool.store.documentationBlocks = [
    { id: 1, position: 5, block_type: 'text' },
    { id: 2, position: 9, block_type: 'text' },
  ];
  const { port, close } = await startServer({ pool });

  const res = await post(port, '/documentation/blocs/reordonner', { block_id: '2' });

  assert.equal(res.status, 302);
  assert.deepEqual(published(pool), [[2, 0], [1, 5]]);
  await close();
});

test('the bulk reorder route is refused without the forms role', async () => {
  const pool = withBlocks(2);
  const { port, close } = await startServer({ pool });

  for (const user of [READER, PILOT]) {
    const res = await post(port, '/documentation/blocs/reordonner', { block_id: ['2', '1'] }, user);
    assert.equal(res.status, 403, `${user.username} ne réordonne rien`);
  }

  assert.deepEqual(published(pool), [[1, 0], [2, 1]]);
  await close();
});

// --------------------------------------------------------------------- direction ▲▼

test('the move route reads "up" as going up, whatever the case', async () => {
  const pool = withBlocks(3);
  const { port, close } = await startServer({ pool });

  // Regression: the ▲ button posts "up" while the route only accepted "haut", so
  // every ▲ was silently applied as a move down.
  const res = await post(port, '/documentation/blocs/3/deplacer', { direction: 'up' });

  assert.equal(res.status, 302);
  assert.deepEqual(published(pool), [[1, 0], [3, 1], [2, 2]]);
  await close();
});

test('the move route reads "down" as going down', async () => {
  const pool = withBlocks(3);
  const { port, close } = await startServer({ pool });

  const res = await post(port, '/documentation/blocs/1/deplacer', { direction: 'down' });

  assert.equal(res.status, 302);
  assert.deepEqual(published(pool), [[2, 0], [1, 1], [3, 2]]);
  await close();
});

test('the move route still understands the legacy "haut"/"bas" values', async () => {
  const pool = withBlocks(2);
  const { port, close } = await startServer({ pool });

  await post(port, '/documentation/blocs/2/deplacer', { direction: 'haut' });
  assert.deepEqual(published(pool), [[2, 0], [1, 1]]);

  await post(port, '/documentation/blocs/2/deplacer', { direction: 'bas' });
  assert.deepEqual(published(pool), [[1, 0], [2, 1]]);
  await close();
});

test('the move route is refused without the forms role', async () => {
  const pool = withBlocks(2);
  const { port, close } = await startServer({ pool });

  const res = await post(port, '/documentation/blocs/2/deplacer', { direction: 'up' }, READER);

  assert.equal(res.status, 403);
  assert.deepEqual(published(pool), [[1, 0], [2, 1]]);
  await close();
});

// ------------------------------------------------------------- create / update still work

test('a manager can create a block from an insertion form', async () => {
  const pool = createFakePool();
  const { port, close } = await startServer({ pool });

  const res = await post(port, '/documentation/blocs', {
    block_type: DOC_BLOCK_TYPES.BULLETS,
    content: 'Règle 1\nRègle 2',
  });

  assert.equal(res.status, 302);
  assert.equal(pool.store.documentationBlocks.length, 1);
  const [block] = pool.store.documentationBlocks;
  assert.equal(block.block_type, 'bullets');
  assert.equal(block.content, 'Règle 1\nRègle 2');
  assert.equal(block.position, 0);
  await close();
});

test('the documentation schema widens its block type ENUM to include separators', async () => {
  const pool = createFakePool();
  // Give the pool a unique schema identity so the service's per-database
  // initialization cache cannot inherit another test's bootstrap.
  pool.config = { host: 'test-host', database: 'documentation-enum-migration' };

  await ensureDocumentationTables(pool);
  await ensureDocumentationTables(pool);

  const create = pool.log.find(({ sql }) => /^CREATE TABLE IF NOT EXISTS documentation_blocks/i.test(sql));
  const migration = pool.log.filter(({ sql }) => /^ALTER TABLE documentation_blocks\s+MODIFY COLUMN block_type/i.test(sql));
  assert.ok(create);
  assert.match(create.sql, /ENUM\('heading', 'text', 'link', 'bullets', 'separator'\)/);
  assert.equal(migration.length, 1, 'the stale enum is widened once for this database');
  assert.match(migration[0].sql, /ENUM\('heading', 'text', 'link', 'bullets', 'separator'\)/);
});

test('a manager can insert a separator between existing blocks at the requested slot', async () => {
  const pool = createFakePool();
  const { port, close } = await startServer({ pool });

  const first = await post(port, '/documentation/blocs', { block_type: DOC_BLOCK_TYPES.HEADING, title: 'Début', at: '0' });
  const second = await post(port, '/documentation/blocs', { block_type: DOC_BLOCK_TYPES.TEXT, content: 'Suite', at: '1' });
  const separator = await post(port, '/documentation/blocs', { block_type: DOC_BLOCK_TYPES.SEPARATOR, at: '1' });

  assert.equal(first.status, 302);
  assert.equal(second.status, 302);
  assert.equal(separator.status, 302);
  assert.deepEqual(
    published(pool).map(([id, position]) => [pool.store.documentationBlocks.find((block) => block.id === id).block_type, position]),
    [['heading', 0], ['separator', 1], ['text', 2]],
  );
  await close();
});

test('a manager still edits a block in place, keeping its position', async () => {
  const pool = withBlocks(2);
  const { port, close } = await startServer({ pool });

  const res = await post(port, '/documentation/blocs/2', {
    block_type: DOC_BLOCK_TYPES.HEADING,
    title: 'Règlement',
  });

  assert.equal(res.status, 302);
  assert.equal(pool.store.documentationBlocks[1].block_type, 'heading');
  assert.equal(pool.store.documentationBlocks[1].title, 'Règlement');
  assert.deepEqual(published(pool), [[1, 0], [2, 1]]);
  await close();
});

test('a reader sees the published blocks without editing controls', async () => {
  const pool = createFakePool();
  pool.store.documentationBlocks = [
    { id: 1, position: 0, block_type: 'heading', title: 'Règlement', content: '', url: '' },
    { id: 2, position: 1, block_type: 'bullets', title: '', content: 'a\nb', url: '' },
    { id: 3, position: 2, block_type: 'separator', title: '', content: '', url: '' },
  ];
  const { port, close } = await startServer({ pool });

  const res = await fetch(`http://localhost:${port}/documentation`, {
    headers: { Cookie: cookieFor(PILOT) },
    redirect: 'manual',
  });
  const html = await res.text();
  const body = html.match(/<main class="container">([\s\S]*?)<\/main>/)?.[1] || '';

  assert.equal(res.status, 200);
  assert.match(body, /<h2 class="doc-heading">Règlement<\/h2>/);
  assert.match(body, /<li>a<\/li>/);
  assert.match(body, /<hr class="doc-separator">/);
  assert.doesNotMatch(body, /class="doc-edit"|data-insert|draggable="true"/);
  assert.doesNotMatch(body, /id="doc-reorder-form"/);
  assert.doesNotMatch(body, /\/documentation\/blocs/);
  assert.doesNotMatch(body, /<details/);
  await close();
});

test('a reader on an empty documentation gets the empty state without insertion controls', async () => {
  const pool = createFakePool();
  const { port, close } = await startServer({ pool });

  const res = await fetch(`http://localhost:${port}/documentation`, {
    headers: { Cookie: cookieFor(PILOT) },
    redirect: 'manual',
  });
  const html = await res.text();
  const body = html.match(/<main class="container">([\s\S]*?)<\/main>/)?.[1] || '';

  assert.equal(res.status, 200);
  assert.match(body, /Aucun contenu n/);
  assert.doesNotMatch(body, /data-insert|class="doc-edit"|doc-reorder-form/);
  assert.doesNotMatch(body, /\/documentation\/blocs/);
  await close();
});
