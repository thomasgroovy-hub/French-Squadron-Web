import { getDatabasePool, getPoolKey } from '../database.js';

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
  CHOICE_SINGLE: 'choice_single',
  CHOICE_MULTIPLE: 'choice_multiple',
  DATE: 'date',
});

export const FIELD_TYPE_VALUES = Object.freeze(Object.values(FIELD_TYPES));

/**
 * Types qui présentent une liste d'options. `options` n'est stocké que pour
 * ceux-ci : les autres questions l'ignorent, ce qui garde la colonne NULL et
 * évite d'attacher des données inutiles à un champ libre.
 */
export const CHOICE_FIELD_TYPES = Object.freeze([
  FIELD_TYPES.CHOICE_SINGLE,
  FIELD_TYPES.CHOICE_MULTIPLE,
]);

export function isChoiceFieldType(fieldType) {
  return CHOICE_FIELD_TYPES.includes(fieldType);
}

/** MySQL ENUM derived from FIELD_TYPES: the schema cannot drift from the list. */
const FIELD_TYPE_ENUM = FIELD_TYPE_VALUES.map((type) => `'${type}'`).join(', ');

export const MAX_OPTIONS_PER_QUESTION = 50;
export const MAX_OPTION_LENGTH = 200;

/**
 * Normalise une liste d'options : chaîne JSON (base) ou tableau (formulaire
 * publié). Renvoie toujours un tableau de chaînes, sans doublon à vide près.
 */
export function parseQuestionOptions(value) {
  let raw = value;
  if (typeof raw === 'string') {
    try {
      raw = JSON.parse(raw);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(raw)) return [];
  const seen = new Set();
  const options = [];
  for (const entry of raw) {
    if (typeof entry !== 'string') continue;
    const option = entry.replace(/\r\n/g, ' ').trim().slice(0, MAX_OPTION_LENGTH);
    if (!option || seen.has(option)) continue;
    seen.add(option);
    options.push(option);
    if (options.length >= MAX_OPTIONS_PER_QUESTION) break;
  }
  return options;
}

const initializedPools = new Map();

/**
 * Creates the forms tables on the shared MySQL pool. Same lazy
 * `CREATE TABLE IF NOT EXISTS` pattern as `services/members.js` so no
 * migration step is required on deploy.
 */
export async function ensureFormsTables(pool) {
  const poolKey = getPoolKey(pool);
  let initialization = initializedPools.get(poolKey);
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
          field_type ENUM(${FIELD_TYPE_ENUM}) NOT NULL DEFAULT 'short',
          options TEXT NULL,
          created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
          INDEX form_questions_form_idx (form_id, position),
          CONSTRAINT form_questions_form_fk FOREIGN KEY (form_id)
            REFERENCES forms (id) ON DELETE CASCADE
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
      `);

      // The `options` column and the widened ENUM are added after the table
      // exists, so a database created before this change is migrated in place on
      // the next boot instead of requiring a manual migration step.
      const [questionColumns] = await pool.execute('SHOW COLUMNS FROM form_questions');
      const columns = Array.isArray(questionColumns) ? questionColumns : [];
      const fieldTypeColumn = columns.find((column) => column?.Field === 'field_type');

      // A pool that cannot answer SHOW COLUMNS is not a reason to fail the boot:
      // a fresh table already carries the column from the CREATE above.
      if (!columns.some((column) => column?.Field === 'options')) {
        await pool.execute('ALTER TABLE form_questions ADD COLUMN options TEXT NULL AFTER field_type');
      }

      // Without this, MySQL would reject a `choice_single` on a database created
      // before the new types. Widening an ENUM never drops an existing value, so
      // it is safe to replay on every boot.
      const currentEnum = String(fieldTypeColumn?.Type || '');
      const enumIsUpToDate = FIELD_TYPE_VALUES.every((type) => currentEnum.includes(`'${type}'`));
      if (columns.length && !enumIsUpToDate) {
        await pool.execute(
          `ALTER TABLE form_questions
           MODIFY COLUMN field_type ENUM(${FIELD_TYPE_ENUM}) NOT NULL DEFAULT 'short'`,
        );
      }

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
      initializedPools.delete(poolKey);
      throw error;
    });
    initializedPools.set(poolKey, initialization);
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
    // An unknown value would break the conditional rendering, so it falls back
    // to the plain text field rather than rendering nothing.
    fieldType: FIELD_TYPE_VALUES.includes(row.field_type) ? row.field_type : FIELD_TYPES.SHORT,
    // Always a parsed array so the views never have to JSON.parse.
    options: parseQuestionOptions(row.options),
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

/**
 * Builds the `forms.creator_discord_id = ?` restriction, or nothing at all.
 *
 * Every ownership-sensitive statement in this file goes through here, so the
 * only way to read another member's forms is to pass `includeAllForms: true`,
 * and the routes only do so after `hasFormsAdminRole` said yes. Keeping the
 * filter in SQL — rather than filtering in the view — is what makes a direct
 * API call useless: there is no request field that reaches this helper.
 */
function ownerClause(creatorDiscordId, includeAllForms, params) {
  if (includeAllForms) return '';
  if (!creatorDiscordId) return null;
  params.push(creatorDiscordId);
  return 'forms.creator_discord_id = ?';
}

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

/**
 * Every form of the site, whatever its status and whoever created it.
 *
 * Powers the administration overview. `limit` bounds the read: this list is a
 * supervision screen, not an export, and an unbounded table scan on every page
 * view would be the only place in this module able to hurt the site.
 */
export async function listAllForms(pool = getDatabasePool(), { limit = 500 } = {}) {
  if (!pool) return [];
  try {
    await ensureFormsTables(pool);
    const maxRows = Number.isInteger(limit) && limit > 0 ? limit : 500;
    const [rows] = await pool.execute(
      `${FORM_SELECT} ORDER BY forms.created_at DESC, forms.id DESC LIMIT ?`,
      [maxRows],
    );
    return rows.map(mapForm);
  } catch (error) {
    console.error('[FormsService] Unable to list every form:', error.message);
    return [];
  }
}

/** Every form owned by a creator, whatever its status. */
export async function listFormsByCreator(creatorDiscordId, pool = getDatabasePool(), { includeAllForms = false } = {}) {
  if (!pool) return [];
  try {
    await ensureFormsTables(pool);
    const params = [];
    const owner = ownerClause(creatorDiscordId, includeAllForms, params);
    if (owner === null) return [];
    const where = owner ? ` WHERE ${owner}` : '';
    const [rows] = await pool.execute(
      `${FORM_SELECT}${where} ORDER BY forms.updated_at DESC, forms.id DESC`,
      params,
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
    'SELECT id, form_id, position, label, help_text, field_type, options FROM form_questions WHERE form_id = ? ORDER BY position ASC, id ASC',
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

  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();

    const [result] = await connection.execute(
      'INSERT INTO forms (creator_discord_id, title, description, granted_role_id) VALUES (?, ?, ?, ?)',
      [creatorDiscordId, title, description, grantedRoleId || null],
    );
    const formId = result.insertId;
    await syncQuestions(formId, questions, connection);
    await connection.commit();

    return getFormById(formId, pool);
  } catch (error) {
    await connection.rollback().catch(() => {});
    throw error;
  } finally {
    connection.release();
  }
}

export async function updateForm({
  formId,
  creatorDiscordId,
  title,
  description = '',
  grantedRoleId = null,
  questions = [],
  includeAllForms = false,
  pool = getDatabasePool(),
}) {
  if (!pool || !formId) return null;
  await ensureFormsTables(pool);

  // Without the administration role, the creator is part of the WHERE clause:
  // a forged `creatorDiscordId` in the request cannot reach another member's
  // form, because the caller is not even allowed to choose that value.
  const params = [title, description, grantedRoleId || null, formId];
  const owner = ownerClause(creatorDiscordId, includeAllForms, params);
  if (owner === null) return null;

  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();

    const [result] = await connection.execute(
      `UPDATE forms
       SET title = ?, description = ?, granted_role_id = ?
       WHERE id = ?${owner ? ` AND ${owner}` : ''}`,
      params,
    );
    if (!result.affectedRows) {
      await connection.rollback();
      return null;
    }
    await syncQuestions(formId, questions, connection);
    await connection.commit();

    return getFormById(formId, pool);
  } catch (error) {
    await connection.rollback().catch(() => {});
    throw error;
  } finally {
    connection.release();
  }
}

/**
 * Rewrites the ordered question list of a form while keeping the `id` of every
 * question that is still there. Responses store their answers as
 * `{ [questionId]: text }`, so regenerating ids here would silently detach
 * every answer already collected on a form that gets edited.
 */
async function syncQuestions(formId, questions, pool) {
  const [existingRows] = await pool.execute(
    'SELECT id FROM form_questions WHERE form_id = ? FOR UPDATE',
    [formId],
  );
  const existingIds = new Set(existingRows.map((row) => Number(row.id)));
  const keptIds = new Set();

  for (const [index, question] of questions.entries()) {
    const fieldType = FIELD_TYPE_VALUES.includes(question.fieldType) ? question.fieldType : FIELD_TYPES.SHORT;
    // Only the choice types carry options; storing them anywhere else would
    // leave dead data behind as soon as the type is switched back.
    const options = isChoiceFieldType(fieldType)
      ? JSON.stringify(parseQuestionOptions(question.options))
      : null;
    const id = Number.parseInt(question.id, 10);
    if (Number.isInteger(id) && existingIds.has(id)) {
      keptIds.add(id);
      await pool.execute(
        `UPDATE form_questions
         SET position = ?, label = ?, help_text = ?, field_type = ?, options = ?
         WHERE id = ? AND form_id = ?`,
        [index, question.label, question.helpText || null, fieldType, options, id, formId],
      );
    } else {
      const [inserted] = await pool.execute(
        'INSERT INTO form_questions (form_id, position, label, help_text, field_type, options) VALUES (?, ?, ?, ?, ?, ?)',
        [formId, index, question.label, question.helpText || null, fieldType, options],
      );
      keptIds.add(Number(inserted.insertId));
    }
  }

  for (const id of existingIds) {
    if (keptIds.has(id)) continue;
    await pool.execute('DELETE FROM form_questions WHERE id = ? AND form_id = ?', [id, formId]);
  }
}

export async function deleteForm(formId, creatorDiscordId, pool = getDatabasePool(), { includeAllForms = false } = {}) {
  if (!pool || !formId) return false;
  await ensureFormsTables(pool);
  const params = [formId];
  const owner = ownerClause(creatorDiscordId, includeAllForms, params);
  if (owner === null) return false;
  const [result] = await pool.execute(
    `DELETE FROM forms WHERE id = ?${owner ? ` AND ${owner}` : ''}`,
    params,
  );
  return Boolean(result.affectedRows);
}

export async function setFormStatus({
  formId,
  creatorDiscordId,
  status,
  includeAllForms = false,
  pool = getDatabasePool(),
}) {
  if (!pool || !formId) return null;
  await ensureFormsTables(pool);
  const params = [status, formId];
  const owner = ownerClause(creatorDiscordId, includeAllForms, params);
  if (owner === null) return null;
  // Republishing resets `published_at`, which is what orders the applicant-facing
  // list; closing deliberately leaves the original publication date alone.
  const publishedColumn = status === FORM_STATUS.OPEN ? ', published_at = CURRENT_TIMESTAMP' : '';
  const [result] = await pool.execute(
    `UPDATE forms SET status = ?${publishedColumn} WHERE id = ?${owner ? ` AND ${owner}` : ''}`,
    params,
  );
  if (!result.affectedRows) return null;
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
      'SELECT MAX(published_at) AS last_published_at FROM forms WHERE creator_discord_id = ? AND published_at IS NOT NULL',
      [creatorDiscordId],
    );
    // `MAX()` over an empty set is NULL: a creator who never published must not be mistaken for someone who just published.
    if (rows[0]?.last_published_at == null) return 0;
    const lastPublishedAt = new Date(rows[0].last_published_at);
    if (Number.isNaN(lastPublishedAt.getTime())) return 0;
    const now = new Date();
    const minutesSince = Math.floor((now.getTime() - lastPublishedAt.getTime()) / 60000);
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

/**
 * The applicant's accepted candidature on a form, if any. An accepted
 * candidature is final: the member is already in, so they must not be able to
 * send another answer on the same form.
 */
export async function findAcceptedResponse(formId, applicantDiscordId, pool = getDatabasePool()) {
  if (!pool || !formId || !applicantDiscordId) return null;
  try {
    await ensureFormsTables(pool);
    const [rows] = await pool.execute(
      'SELECT * FROM form_responses WHERE form_id = ? AND applicant_discord_id = ? AND status = ? ORDER BY created_at DESC LIMIT 1',
      [formId, applicantDiscordId, RESPONSE_STATUS.ACCEPTED],
    );
    return mapResponse(rows[0]);
  } catch (error) {
    console.error(`[FormsService] Unable to check accepted response for ${applicantDiscordId}:`, error.message);
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
    // cannot both pass the "one pending candidature" check. The accepted rows
    // are locked first: a member already accepted must stay blocked even if a
    // second request lands at the same moment.
    if (connection) {
      await connection.execute(
        'SELECT id FROM form_responses WHERE form_id = ? AND applicant_discord_id = ? AND status = ? LIMIT 1 FOR UPDATE',
        [formId, applicantDiscordId, RESPONSE_STATUS.ACCEPTED],
      );
      await connection.execute(
        'SELECT id FROM form_responses WHERE form_id = ? AND applicant_discord_id = ? AND status = ? LIMIT 1 FOR UPDATE',
        [formId, applicantDiscordId, RESPONSE_STATUS.PENDING],
      );
    }

    const executor = connection || pool;
    const [acceptedRows] = await executor.execute(
      'SELECT id FROM form_responses WHERE form_id = ? AND applicant_discord_id = ? AND status = ? LIMIT 1',
      [formId, applicantDiscordId, RESPONSE_STATUS.ACCEPTED],
    );
    if (acceptedRows.length) {
      if (connection) await connection.rollback();
      return { error: 'accepted', response: mapResponse(acceptedRows[0]) };
    }

    const [pendingRows] = await executor.execute(
      'SELECT id FROM form_responses WHERE form_id = ? AND applicant_discord_id = ? AND status = ? LIMIT 1',
      [formId, applicantDiscordId, RESPONSE_STATUS.PENDING],
    );
    if (pendingRows.length) {
      if (connection) await connection.rollback();
      return { error: 'pending', response: mapResponse(pendingRows[0]) };
    }

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
 * Candidatures for the forms of `creatorDiscordId` only — or for every form of
 * the site when `includeAllForms` is set, which only the administration roles
 * can obtain. The creator filter lives in the SQL, not in the view, so a
 * manager can never read another manager's answers by calling the route
 * directly.
 */
export async function listResponsesByCreator(creatorDiscordId, pool = getDatabasePool(), { formId = null, includeAllForms = false } = {}) {
  if (!pool) return [];
  try {
    await ensureFormsTables(pool);
    const params = [];
    const conditions = [];
    const owner = ownerClause(creatorDiscordId, includeAllForms, params);
    if (owner === null) return [];
    if (owner) conditions.push(owner);
    if (formId) {
      conditions.push('forms.id = ?');
      params.push(formId);
    }
    const where = conditions.length ? ` WHERE ${conditions.join(' AND ')}` : '';
    const [rows] = await pool.execute(
      `SELECT form_responses.*, forms.title AS form_title
       FROM form_responses
       INNER JOIN forms ON forms.id = form_responses.form_id${where}
       ORDER BY FIELD(form_responses.status, 'pending', 'accepted', 'rejected'), form_responses.created_at DESC`,
      params,
    );
    return rows.map(mapResponse);
  } catch (error) {
    console.error(`[FormsService] Unable to list responses for ${creatorDiscordId}:`, error.message);
    return [];
  }
}

export async function countResponsesByCreator(creatorDiscordId, pool = getDatabasePool(), { includeAllForms = false } = {}) {
  const responses = await listResponsesByCreator(creatorDiscordId, pool, { includeAllForms });
  return responses.filter((response) => response.status === RESPONSE_STATUS.PENDING).length;
}

/** Loads one candidature, enforcing ownership on the parent form. */
export async function getResponseById(responseId, creatorDiscordId, pool = getDatabasePool(), { includeAllForms = false } = {}) {
  if (!pool || !responseId) return null;
  try {
    await ensureFormsTables(pool);
    const params = [responseId];
    const owner = ownerClause(creatorDiscordId, includeAllForms, params);
    if (owner === null) return null;
    const [rows] = await pool.execute(
      `SELECT form_responses.*, forms.title AS form_title, forms.creator_discord_id AS form_creator,
              forms.granted_role_id AS granted_role_id
       FROM form_responses
       INNER JOIN forms ON forms.id = form_responses.form_id
       WHERE form_responses.id = ?${owner ? ` AND ${owner}` : ''}
       LIMIT 1`,
      params,
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
 *
 * The ownership restriction is a second predicate on the same statement rather
 * than a check before it: an administration-role reviewer must still match
 * exactly one pending row, so a double click stays harmless for them too.
 */
export async function updateResponseStatus({
  responseId,
  creatorDiscordId,
  status,
  reviewerDiscordId,
  includeAllForms = false,
  pool = getDatabasePool(),
}) {
  if (!pool || !responseId) return null;
  await ensureFormsTables(pool);
  const params = [status, reviewerDiscordId, responseId];
  const owner = ownerClause(creatorDiscordId, includeAllForms, params);
  if (owner === null) return null;
  const [result] = await pool.execute(
    `UPDATE form_responses
     SET status = ?, reviewer_discord_id = ?, reviewed_at = CURRENT_TIMESTAMP
     WHERE id = ?
       AND status = 'pending'${owner ? ` AND form_id IN (SELECT id FROM forms WHERE ${owner})` : ''}`,
    params,
  );
  if (!result.affectedRows) return null;
  return getResponseById(responseId, creatorDiscordId, pool, { includeAllForms });
}
