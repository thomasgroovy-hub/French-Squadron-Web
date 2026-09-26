import { getDatabasePool } from '../database.js';

export const FORM_STATUS = Object.freeze({
  DRAFT: 'draft',
  OPEN: 'open',
  CLOSED: 'closed',
});

export const RESPONSE_STATUS = Object.freeze({
  PENDING: 'pending',
  ACCEPTED: 'accepted',
  REJECTED: 'rejected',
});

export const FIELD_TYPES = Object.freeze({
  SHORT: 'short',
  LONG: 'long',
});

export const FIELD_TYPE_VALUES = Object.freeze(Object.values(FIELD_TYPES));

const initializedPools = new WeakMap();

/**
 * Creates the forms tables on the shared MySQL pool. Same lazy
 * `CREATE TABLE IF NOT EXISTS` pattern as `services/members.js` so no
 * migration step is required on deploy.
 */
export async function ensureFormsTables(pool) {
  let initialization = initializedPools.get(pool);
  if (!initialization) {
    initialization = (async () => {
      await pool.execute(`
        CREATE TABLE IF NOT EXISTS forms (
          id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
          creator_discord_id VARCHAR(20) NOT NULL,
          title VARCHAR(120) NOT NULL,
          description TEXT NULL,
          granted_role_id VARCHAR(20) NULL,
          status ENUM('draft', 'open', 'closed') NOT NULL DEFAULT 'draft',
          published_at DATETIME NULL,
          created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
          INDEX forms_creator_idx (creator_discord_id),
          INDEX forms_status_idx (status)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
      `);

      await pool.execute(`
        CREATE TABLE IF NOT EXISTS form_questions (
          id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
          form_id INT UNSIGNED NOT NULL,
          position INT UNSIGNED NOT NULL DEFAULT 0,
          label VARCHAR(200) NOT NULL,
          help_text VARCHAR(500) NULL,
          field_type ENUM('short', 'long') NOT NULL DEFAULT 'short',
          created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
          INDEX form_questions_form_idx (form_id, position),
          CONSTRAINT form_questions_form_fk FOREIGN KEY (form_id)
            REFERENCES forms (id) ON DELETE CASCADE
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
      `);

      await pool.execute(`
        CREATE TABLE IF NOT EXISTS form_responses (
          id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
          form_id INT UNSIGNED NOT NULL,
          applicant_discord_id VARCHAR(20) NOT NULL,
          status ENUM('pending', 'accepted', 'rejected') NOT NULL DEFAULT 'pending',
          answers JSON NOT NULL,
          reviewer_discord_id VARCHAR(20) NULL,
          reviewed_at DATETIME NULL,
          created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
          INDEX form_responses_form_idx (form_id, status),
          INDEX form_responses_applicant_idx (applicant_discord_id),
          CONSTRAINT form_responses_form_fk FOREIGN KEY (form_id)
            REFERENCES forms (id) ON DELETE CASCADE
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
      `);
    })().catch((error) => {
      initializedPools.delete(pool);
      throw error;
    });
    initializedPools.set(pool, initialization);
  }
  return initialization;
}

function mapForm(row) {
  if (!row) return null;
  return {
    id: row.id,
    creatorDiscordId: row.creator_discord_id,
    title: row.title,
    description: row.description || '',
    grantedRoleId: row.granted_role_id || null,
    status: row.status,
    publishedAt: row.published_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    pendingCount: Number(row.pending_count || 0),
    responseCount: Number(row.response_count || 0),
  };
}

function mapQuestion(row) {
  return {
    id: row.id,
    formId: row.form_id,
    position: Number(row.position),
    label: row.label,
    helpText: row.help_text || '',
    fieldType: row.field_type,
  };
}

function mapResponse(row) {
  if (!row) return null;
  let answers = {};
  if (row.answers && typeof row.answers === 'object') {
    answers = row.answers;
  } else if (typeof row.answers === 'string') {
    try {
      answers = JSON.parse(row.answers);
    } catch {
      answers = {};
    }
  }
  return {
    id: row.id,
    formId: row.form_id,
    formTitle: row.form_title || null,
    applicantDiscordId: row.applicant_discord_id,
    status: row.status,
    answers,
    reviewerDiscordId: row.reviewer_discord_id || null,
    reviewedAt: row.reviewed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const FORM_SELECT = `
  SELECT forms.*,
         (SELECT COUNT(*) FROM form_responses r WHERE r.form_id = forms.id) AS response_count,
         (SELECT COUNT(*) FROM form_responses r WHERE r.form_id = forms.id AND r.status = 'pending') AS pending_count
  FROM forms`;

/** All forms currently open to applicants. */
export async function listPublishedForms(pool = getDatabasePool()) {
  if (!pool) return [];
  try {
    await ensureFormsTables(pool);
    const [rows] = await pool.execute(
      `${FORM_SELECT} WHERE forms.status = ? ORDER BY forms.published_at DESC, forms.id DESC`,
      [FORM_STATUS.OPEN],
    );
    return rows.map(mapForm);
  } catch (error) {
    console.error('[FormsService] Unable to list published forms:', error.message);
    return [];
  }
}

/** Every form owned by a creator, whatever its status. */
export async function listFormsByCreator(creatorDiscordId, pool = getDatabasePool()) {
  if (!pool || !creatorDiscordId) return [];
  try {
    await ensureFormsTables(pool);
    const [rows] = await pool.execute(
      `${FORM_SELECT} WHERE forms.creator_discord_id = ? ORDER BY forms.updated_at DESC, forms.id DESC`,
      [creatorDiscordId],
    );
    return rows.map(mapForm);
  } catch (error) {
    console.error(`[FormsService] Unable to list forms for ${creatorDiscordId}:`, error.message);
    return [];
  }
}

export async function getFormById(formId, pool = getDatabasePool(), { withQuestions = true } = {}) {
  if (!pool || !formId) return null;
  try {
    await ensureFormsTables(pool);
    const [rows] = await pool.execute(`${FORM_SELECT} WHERE forms.id = ? LIMIT 1`, [formId]);
    const form = mapForm(rows[0]);
    if (!form || !withQuestions) return form;
    form.questions = await listQuestions(formId, pool);
    return form;
  } catch (error) {
    console.error(`[FormsService] Unable to load form ${formId}:`, error.message);
    return null;
  }
}

export async function listQuestions(formId, pool = getDatabasePool()) {
  if (!pool || !formId) return [];
  const [rows] = await pool.execute(
    'SELECT id, form_id, position, label, help_text, field_type FROM form_questions WHERE form_id = ? ORDER BY position ASC, id ASC',
    [formId],
  );
  return rows.map(mapQuestion);
}

export async function createForm({
  creatorDiscordId,
  title,
  description = '',
  grantedRoleId = null,
  questions = [],
  pool = getDatabasePool(),
}) {
  if (!pool) return null;
  await ensureFormsTables(pool);
  const [result] = await pool.execute(
    'INSERT INTO forms (creator_discord_id, title, description, granted_role_id) VALUES (?, ?, ?, ?)',
    [creatorDiscordId, title, description, grantedRoleId || null],
  );
  const formId = result.insertId;
  await syncQuestions(formId, questions, pool);
  return getFormById(formId, pool);
}

export async function updateForm({
  formId,
  creatorDiscordId,
  title,
  description = '',
  grantedRoleId = null,
  questions = [],
  pool = getDatabasePool(),
}) {
  if (!pool || !formId) return null;
  await ensureFormsTables(pool);
  const [result] = await pool.execute(
    `UPDATE forms
     SET title = ?, description = ?, granted_role_id = ?
     WHERE id = ? AND creator_discord_id = ?`,
    [title, description, grantedRoleId || null, formId, creatorDiscordId],
  );
  if (!result.affectedRows) return null;
  await syncQuestions(formId, questions, pool);
  return getFormById(formId, pool);
}

/**
 * Rewrites the ordered question list of a form while keeping the `id` of every
 * question that is still there. Responses store their answers as
 * `{ [questionId]: text }`, so regenerating ids here would silently detach
 * every answer already collected on a form that gets edited.
 */
async function syncQuestions(formId, questions, pool) {
  const [existingRows] = await pool.execute(
    'SELECT id FROM form_questions WHERE form_id = ?',
    [formId],
  );
  const existingIds = new Set(existingRows.map((row) => Number(row.id)));
  const keptIds = new Set();

  for (const [index, question] of questions.entries()) {
    const id = Number.parseInt(question.id, 10);
    if (Number.isInteger(id) && existingIds.has(id)) {
      keptIds.add(id);
      await pool.execute(
        `UPDATE form_questions
         SET position = ?, label = ?, help_text = ?, field_type = ?
         WHERE id = ? AND form_id = ?`,
        [index, question.label, question.helpText || null, question.fieldType, id, formId],
      );
    } else {
      const [inserted] = await pool.execute(
        'INSERT INTO form_questions (form_id, position, label, help_text, field_type) VALUES (?, ?, ?, ?, ?)',
        [formId, index, question.label, question.helpText || null, question.fieldType],
      );
      keptIds.add(Number(inserted.insertId));
    }
  }

  for (const id of existingIds) {
    if (keptIds.has(id)) continue;
    await pool.execute('DELETE FROM form_questions WHERE id = ? AND form_id = ?', [id, formId]);
  }
}

export async function deleteForm(formId, creatorDiscordId, pool = getDatabasePool()) {
  if (!pool || !formId) return false;
  await ensureFormsTables(pool);
  const [result] = await pool.execute(
    'DELETE FROM forms WHERE id = ? AND creator_discord_id = ?',
    [formId, creatorDiscordId],
  );
  return Boolean(result.affectedRows);
}

export async function setFormStatus({
  formId,
  creatorDiscordId,
  status,
  pool = getDatabasePool(),
}) {
  if (!pool || !formId) return null;
  await ensureFormsTables(pool);
  if (status === FORM_STATUS.OPEN) {
    const [result] = await pool.execute(
      'UPDATE forms SET status = ?, published_at = CURRENT_TIMESTAMP WHERE id = ? AND creator_discord_id = ?',
      [status, formId, creatorDiscordId],
    );
    if (!result.affectedRows) return null;
  } else {
    const [result] = await pool.execute(
      'UPDATE forms SET status = ? WHERE id = ? AND creator_discord_id = ?',
      [status, formId, creatorDiscordId],
    );
    if (!result.affectedRows) return null;
  }
  return getFormById(formId, pool);
}

/**
 * Rate limit for publication: a creator cannot publish more than one form per
 * `cooldownMinutes`. Returns the number of whole minutes still to wait, or 0
 * when publication is allowed.
 */
export async function getPublishCooldownRemaining(creatorDiscordId, cooldownMinutes, pool = getDatabasePool()) {
  if (!pool || !creatorDiscordId) return 0;
  const cooldown = Number.isFinite(cooldownMinutes) && cooldownMinutes > 0 ? cooldownMinutes : 0;
  if (!cooldown) return 0;
  try {
    await ensureFormsTables(pool);
    const [rows] = await pool.execute(
      'SELECT MAX(published_at) AS last_published_at, TIMESTAMPDIFF(MINUTE, MAX(published_at), CURRENT_TIMESTAMP) AS minutes_since FROM forms WHERE creator_discord_id = ? AND published_at IS NOT NULL',
      [creatorDiscordId],
    );
    // `MAX()` over an empty set is NULL, and `Number(null)` is 0: a creator who
    // never published must not be mistaken for someone who just published.
    if (rows[0]?.last_published_at == null) return 0;
    const minutesSince = Number(rows[0]?.minutes_since);
    if (!Number.isFinite(minutesSince)) return 0;
    return Math.max(0, Math.ceil(cooldown - minutesSince));
  } catch (error) {
    console.error(`[FormsService] Unable to compute publish cooldown for ${creatorDiscordId}:`, error.message);
    return 0;
  }
}

/** The applicant's pending candidature on a form, if any. */
export async function findPendingResponse(formId, applicantDiscordId, pool = getDatabasePool()) {
  if (!pool || !formId || !applicantDiscordId) return null;
  try {
    await ensureFormsTables(pool);
    const [rows] = await pool.execute(
      'SELECT * FROM form_responses WHERE form_id = ? AND applicant_discord_id = ? AND status = ? ORDER BY created_at DESC LIMIT 1',
      [formId, applicantDiscordId, RESPONSE_STATUS.PENDING],
    );
    return mapResponse(rows[0]);
  } catch (error) {
    console.error(`[FormsService] Unable to check pending response for ${applicantDiscordId}:`, error.message);
    return null;
  }
}

export async function submitResponse({
  formId,
  applicantDiscordId,
  answers = {},
  pool = getDatabasePool(),
}) {
  if (!pool || !formId || !applicantDiscordId) return null;
  await ensureFormsTables(pool);
  const connection = typeof pool.getConnection === 'function' ? await pool.getConnection() : null;
  try {
    if (connection) await connection.beginTransaction();

    // Serialises concurrent submissions from the same applicant so two clicks
    // cannot both pass the "one pending candidature" check.
    if (connection) {
      await connection.execute(
        'SELECT id FROM form_responses WHERE form_id = ? AND applicant_discord_id = ? AND status = ? LIMIT 1 FOR UPDATE',
        [formId, applicantDiscordId, RESPONSE_STATUS.PENDING],
      );
    }

    const [pendingRows] = await (connection || pool).execute(
      'SELECT id FROM form_responses WHERE form_id = ? AND applicant_discord_id = ? AND status = ? LIMIT 1',
      [formId, applicantDiscordId, RESPONSE_STATUS.PENDING],
    );
    if (pendingRows.length) {
      if (connection) await connection.rollback();
      return { error: 'pending', response: mapResponse(pendingRows[0]) };
    }

    const executor = connection || pool;
    const [result] = await executor.execute(
      'INSERT INTO form_responses (form_id, applicant_discord_id, status, answers) VALUES (?, ?, ?, ?)',
      [formId, applicantDiscordId, RESPONSE_STATUS.PENDING, JSON.stringify(answers)],
    );
    if (connection) await connection.commit();
    return { error: null, responseId: result.insertId };
  } catch (error) {
    if (connection) await connection.rollback().catch(() => {});
    throw error;
  } finally {
    if (connection) connection.release();
  }
}

/**
 * Candidatures for the forms owned by `creatorDiscordId` only. The creator
 * filter lives in the SQL, not in the view, so a manager can never read
 * another manager's answers.
 */
export async function listResponsesByCreator(creatorDiscordId, pool = getDatabasePool(), { formId = null } = {}) {
  if (!pool || !creatorDiscordId) return [];
  try {
    await ensureFormsTables(pool);
    const params = [creatorDiscordId];
    let sql = `SELECT form_responses.*, forms.title AS form_title
       FROM form_responses
       INNER JOIN forms ON forms.id = form_responses.form_id
       WHERE forms.creator_discord_id = ?`;
    if (formId) {
      sql += ' AND forms.id = ?';
      params.push(formId);
    }
    sql += ` ORDER BY FIELD(form_responses.status, 'pending', 'accepted', 'rejected'), form_responses.created_at DESC`;

    const [rows] = await pool.execute(sql, params);
    return rows.map(mapResponse);
  } catch (error) {
    console.error(`[FormsService] Unable to list responses for ${creatorDiscordId}:`, error.message);
    return [];
  }
}

export async function countResponsesByCreator(creatorDiscordId, pool = getDatabasePool()) {
  const responses = await listResponsesByCreator(creatorDiscordId, pool);
  return responses.filter((response) => response.status === RESPONSE_STATUS.PENDING).length;
}

/** Loads one candidature, enforcing ownership on the parent form. */
export async function getResponseById(responseId, creatorDiscordId, pool = getDatabasePool()) {
  if (!pool || !responseId || !creatorDiscordId) return null;
  try {
    await ensureFormsTables(pool);
    const [rows] = await pool.execute(
      `SELECT form_responses.*, forms.title AS form_title, forms.creator_discord_id AS form_creator,
              forms.granted_role_id AS granted_role_id
       FROM form_responses
       INNER JOIN forms ON forms.id = form_responses.form_id
       WHERE form_responses.id = ? AND forms.creator_discord_id = ?
       LIMIT 1`,
      [responseId, creatorDiscordId],
    );
    if (!rows.length) return null;
    const response = mapResponse(rows[0]);
    response.grantedRoleId = rows[0].granted_role_id || null;
    response.formCreatorId = rows[0].form_creator;
    response.questions = await listQuestions(response.formId, pool);
    return response;
  } catch (error) {
    console.error(`[FormsService] Unable to load response ${responseId}:`, error.message);
    return null;
  }
}

/**
 * Claims a candidature and records the decision in a single statement.
 *
 * The `status = 'pending'` predicate is what makes the claim atomic: two
 * concurrent reviews both read the candidature as pending, but only the first
 * UPDATE matches a row, so the Discord role and the direct message can never be
 * sent twice. Returns null when the candidature was already processed.
 */
export async function updateResponseStatus({
  responseId,
  creatorDiscordId,
  status,
  reviewerDiscordId,
  pool = getDatabasePool(),
}) {
  if (!pool || !responseId) return null;
  await ensureFormsTables(pool);
  const [result] = await pool.execute(
    `UPDATE form_responses
     SET status = ?, reviewer_discord_id = ?, reviewed_at = CURRENT_TIMESTAMP
     WHERE id = ?
       AND status = 'pending'
       AND form_id IN (SELECT id FROM forms WHERE creator_discord_id = ?)`,
    [status, reviewerDiscordId, responseId, creatorDiscordId],
  );
  if (!result.affectedRows) return null;
  return getResponseById(responseId, creatorDiscordId, pool);
}
