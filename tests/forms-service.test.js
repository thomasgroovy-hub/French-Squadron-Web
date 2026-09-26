import './helpers/env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ensureFormsTables,
  updateForm,
  getPublishCooldownRemaining,
  findPendingResponse,
  submitResponse,
  listResponsesByCreator,
  getResponseById,
  updateResponseStatus,
  RESPONSE_STATUS,
} from '../src/services/forms.js';

/**
 * Recording pool: captures every statement and answers SELECTs from a small
 * scripted queue. Enough to assert the SQL contracts the routes depend on.
 */
function recordingPool({ rows = () => [], affectedRows = 1, insertId = 1 } = {}) {
  const statements = [];
  return {
    statements,
    execute: async (query, params = []) => {
      const sql = query.replace(/\s+/g, ' ').trim();
      statements.push({ sql, params });
      if (/^\s*(CREATE|ALTER)/i.test(sql)) return [[]];
      if (/^\s*SELECT/i.test(sql)) return [rows(sql, params)];
      return [{ affectedRows, insertId }];
    },
  };
}

const findStatement = (pool, pattern) => pool.statements.find((entry) => pattern.test(entry.sql));

test('table bootstrap creates the three forms tables', async () => {
  const pool = recordingPool();
  await ensureFormsTables(pool);

  const created = pool.statements.map((entry) => entry.sql).join('\n');
  for (const table of ['forms', 'form_questions', 'form_responses']) {
    assert.match(created, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}\\b`));
  }
  // Answers are stored as JSON keyed by question id.
  assert.match(created, /answers JSON NOT NULL/);
  // Deleting a form must take its questions and responses with it.
  assert.match(created, /ON DELETE CASCADE/);
});

test('updateForm keeps the id of questions that are still present', async () => {
  // The pool reports two existing questions on the form being edited.
  const pool = recordingPool({
    rows: (sql) => (/FROM form_questions WHERE form_id/.test(sql)
      ? [{ id: 11 }, { id: 12 }]
      : []),
  });

  await updateForm({
    formId: 5,
    creatorDiscordId: 'manager-1',
    title: 'Recrutement',
    questions: [
      // Swapped order, renamed: both ids already exist, so both are updated.
      { id: 12, label: 'Présentation', helpText: 'En quelques lignes', fieldType: 'long' },
      { id: 11, label: 'Motivation', helpText: '', fieldType: 'short' },
    ],
    pool,
  });

  const updates = pool.statements.filter((entry) => /^UPDATE form_questions/.test(entry.sql));
  const inserts = pool.statements.filter((entry) => /^INSERT INTO form_questions/.test(entry.sql));
  const deletes = pool.statements.filter((entry) => /^DELETE FROM form_questions/.test(entry.sql));

  assert.equal(updates.length, 2, 'both surviving questions are updated in place');
  assert.equal(inserts.length, 0, 'no question is re-inserted, so answer keys stay valid');
  assert.equal(deletes.length, 0, 'nothing is deleted when no question was removed');
  assert.deepEqual(updates.map((entry) => entry.params[4]), [12, 11]);
  assert.deepEqual(updates.map((entry) => entry.params[0]), [0, 1]);
});

test('updateForm deletes only the questions the creator actually removed', async () => {
  const pool = recordingPool({
    rows: (sql) => (/FROM form_questions WHERE form_id/.test(sql)
      ? [{ id: 11 }, { id: 12 }, { id: 13 }]
      : []),
  });

  await updateForm({
    formId: 5,
    creatorDiscordId: 'manager-1',
    title: 'Recrutement',
    questions: [
      { id: 11, label: 'Motivation', helpText: '', fieldType: 'short' },
      { id: 13, label: 'Disponibilités', helpText: '', fieldType: 'short' },
    ],
    pool,
  });

  const deletes = pool.statements.filter((entry) => /^DELETE FROM form_questions/.test(entry.sql));
  assert.equal(deletes.length, 1);
  assert.deepEqual(deletes[0].params, [12, 5]);
});

test('updateForm appends brand new questions and keeps the existing ones', async () => {
  const pool = recordingPool({
    rows: (sql) => (/FROM form_questions WHERE form_id/.test(sql) ? [{ id: 11 }] : []),
    insertId: 99,
  });

  await updateForm({
    formId: 5,
    creatorDiscordId: 'manager-1',
    title: 'Recrutement',
    questions: [
      { id: 11, label: 'Motivation', helpText: '', fieldType: 'short' },
      { id: null, label: 'Expérience', helpText: '', fieldType: 'long' },
    ],
    pool,
  });

  assert.equal(pool.statements.filter((entry) => /^UPDATE form_questions/.test(entry.sql)).length, 1);
  const inserts = pool.statements.filter((entry) => /^INSERT INTO form_questions/.test(entry.sql));
  assert.equal(inserts.length, 1);
  assert.deepEqual(inserts[0].params, [5, 1, 'Expérience', null, 'long']);
});

test('publish cooldown is per creator and counts down from the last publication', async () => {
  const pool = recordingPool({ rows: () => [{ last_published_at: new Date(), minutes_since: 10 }] });
  const remaining = await getPublishCooldownRemaining('manager-1', 30, pool);

  assert.equal(remaining, 20);
  const statement = findStatement(pool, /MAX\(published_at\)/);
  assert.ok(statement, 'cooldown reads the last publication date');
  assert.deepEqual(statement.params, ['manager-1']);
  assert.match(statement.sql, /creator_discord_id = \?/, 'the limit is scoped to one creator');
});

test('a zero or invalid cooldown disables the rate limit', async () => {
  for (const cooldown of [0, -5, Number.NaN, undefined]) {
    const pool = recordingPool();
    assert.equal(await getPublishCooldownRemaining('manager-1', cooldown, pool), 0);
    assert.equal(pool.statements.length, 0, 'no query is issued when the limit is disabled');
  }
});

test('a creator who never published is never rate limited', async () => {
  // MySQL answers NULL for MAX() over an empty set.
  const pool = recordingPool({ rows: () => [{ last_published_at: null, minutes_since: null }] });
  assert.equal(await getPublishCooldownRemaining('manager-1', 30, pool), 0);
});

test('a pending candidature is found per form and per applicant', async () => {
  const pool = recordingPool({
    rows: () => [{
      id: 42,
      form_id: 5,
      applicant_discord_id: 'applicant-1',
      status: RESPONSE_STATUS.PENDING,
      answers: { 11: 'Bonjour' },
      created_at: new Date('2026-01-01T00:00:00Z'),
    }],
  });

  const pending = await findPendingResponse(5, 'applicant-1', pool);
  assert.equal(pending.id, 42);
  assert.equal(pending.status, RESPONSE_STATUS.PENDING);
  assert.deepEqual(pending.answers, { 11: 'Bonjour' });

  const statement = findStatement(pool, /FROM form_responses WHERE form_id/);
  assert.deepEqual(statement.params, [5, 'applicant-1', RESPONSE_STATUS.PENDING]);
  assert.match(statement.sql, /status = \?/, 'only a pending candidature blocks a new submission');
});

test('submitResponse stores answers keyed by question id', async () => {
  const pool = recordingPool({ insertId: 77 });
  await submitResponse({
    formId: 5,
    applicantDiscordId: 'applicant-1',
    answers: { 11: 'Motivation', 12: 'Longue réponse' },
    pool,
  });

  const insert = findStatement(pool, /INSERT INTO form_responses/);
  assert.ok(insert);
  assert.deepEqual(insert.params.slice(0, 3), [5, 'applicant-1', RESPONSE_STATUS.PENDING]);
  assert.deepEqual(JSON.parse(insert.params[3]), { 11: 'Motivation', 12: 'Longue réponse' });
});

test('submitResponse refuses a second candidature while one is pending', async () => {
  const pendingRow = {
    id: 42,
    form_id: 5,
    applicant_discord_id: 'applicant-1',
    status: RESPONSE_STATUS.PENDING,
    answers: { 11: 'Déjà envoyé' },
    created_at: new Date('2026-01-01T00:00:00Z'),
  };
  // The status is a bound parameter (third one), so the fake has to answer
  // per status instead of replaying one row for every SELECT.
  const pool = recordingPool({
    rows: (sql, params) => (params?.[2] === RESPONSE_STATUS.ACCEPTED ? [] : [pendingRow]),
  });

  const outcome = await submitResponse({
    formId: 5,
    applicantDiscordId: 'applicant-1',
    answers: { 11: 'Encore' },
    pool,
  });

  assert.equal(outcome.error, 'pending');
  assert.equal(outcome.response.id, 42);
  assert.equal(findStatement(pool, /INSERT INTO form_responses/), undefined, 'nothing is inserted');
});

test('submitResponse refuses any new candidature once one is accepted', async () => {
  const acceptedRow = {
    id: 77,
    form_id: 5,
    applicant_discord_id: 'applicant-1',
    status: RESPONSE_STATUS.ACCEPTED,
    answers: { 11: 'Déjà accepté' },
    created_at: new Date('2026-01-01T00:00:00Z'),
  };
  const pool = recordingPool({
    rows: (sql, params) => (params?.[2] === RESPONSE_STATUS.ACCEPTED ? [acceptedRow] : []),
  });

  const outcome = await submitResponse({
    formId: 5,
    applicantDiscordId: 'applicant-1',
    answers: { 11: 'Encore' },
    pool,
  });

  assert.equal(outcome.error, 'accepted', 'an accepted candidature is final');
  assert.equal(outcome.response.id, 77);
  assert.equal(findStatement(pool, /INSERT INTO form_responses/), undefined, 'nothing is inserted');
});

test('submitResponse locks the accepted rows before the pending ones', async () => {
  // The FOR UPDATE guards only run when the pool hands out a dedicated
  // connection, so this fake needs getConnection like mysql2's pool.
  const statements = [];
  const connection = {
    beginTransaction: async () => {},
    execute: async (query, params = []) => {
      const sql = query.replace(/\s+/g, ' ').trim();
      statements.push({ sql, params });
      if (/^\s*SELECT/i.test(sql)) return [[]];
      return [{ affectedRows: 1, insertId: 1 }];
    },
    commit: async () => {},
    rollback: async () => {},
    release: () => {},
  };
  const pool = {
    statements,
    getConnection: async () => connection,
    execute: async () => [[]],
  };

  await submitResponse({ formId: 5, applicantDiscordId: 'applicant-1', answers: {}, pool });

  const locks = statements.filter((entry) => /FOR UPDATE/.test(entry.sql));
  assert.equal(locks.length, 2, 'both statuses are locked');
  assert.equal(locks[0].params[2], RESPONSE_STATUS.ACCEPTED, 'accepted is locked first');
  assert.equal(locks[1].params[2], RESPONSE_STATUS.PENDING);
});

test('listing responses filters on the form owner in SQL, not in the view', async () => {
  const pool = recordingPool({ rows: () => [] });
  await listResponsesByCreator('manager-1', pool);

  const statement = findStatement(pool, /FROM form_responses/);
  assert.ok(statement, 'responses are read through the forms join');
  assert.match(statement.sql, /INNER JOIN forms ON forms\.id = form_responses\.form_id/);
  assert.match(statement.sql, /forms\.creator_discord_id = \?/);
  assert.deepEqual(statement.params, ['manager-1']);
});

test('reading one candidature enforces ownership on the parent form', async () => {
  const pool = recordingPool({ rows: () => [] });
  assert.equal(await getResponseById(42, 'manager-1', pool), null);

  const statement = findStatement(pool, /form_responses\.id = \?/);
  assert.ok(statement);
  assert.match(statement.sql, /forms\.creator_discord_id = \?/);
  assert.deepEqual(statement.params, [42, 'manager-1']);
});

test('a decision only matches a still-pending candidature, so it cannot be applied twice', async () => {
  const pool = recordingPool({ affectedRows: 0 });
  const result = await updateResponseStatus({
    responseId: 42,
    creatorDiscordId: 'manager-1',
    status: RESPONSE_STATUS.ACCEPTED,
    reviewerDiscordId: 'manager-1',
    pool,
  });

  assert.equal(result, null, 'a second reviewer gets nothing and grants nothing');
  const update = pool.statements.find((entry) => /^UPDATE form_responses/.test(entry.sql));
  assert.ok(update, 'the claim is a single conditional UPDATE');
  assert.match(update.sql, /AND status = 'pending'/, 'the pending predicate makes the claim atomic');
  assert.match(update.sql, /form_id IN \(SELECT id FROM forms WHERE creator_discord_id = \?\)/, 'ownership is part of the same statement');
  assert.deepEqual(update.params, [RESPONSE_STATUS.ACCEPTED, 'manager-1', 42, 'manager-1']);
});
