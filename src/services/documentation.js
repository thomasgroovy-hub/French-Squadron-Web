import { getDatabasePool, getPoolKey } from '../database.js';

export const DOC_BLOCK_TYPES = Object.freeze({
  HEADING: 'heading',
  TEXT: 'text',
  LINK: 'link',
  BULLETS: 'bullets',
  SEPARATOR: 'separator',
});

export const DOC_BLOCK_TYPE_VALUES = Object.freeze(Object.values(DOC_BLOCK_TYPES));

/** MySQL ENUM derived from DOC_BLOCK_TYPES: the schema cannot drift from the list. */
const DOC_BLOCK_TYPE_ENUM = DOC_BLOCK_TYPE_VALUES.map((type) => `'${type}'`).join(', ');

const initializedPools = new Map();

export async function ensureDocumentationTables(pool) {
  const poolKey = getPoolKey(pool);
  let initialization = initializedPools.get(poolKey);
  if (!initialization) {
    initialization = (async () => {
      await pool.execute(`
      CREATE TABLE IF NOT EXISTS documentation_blocks (
        id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
        position INT UNSIGNED NOT NULL DEFAULT 0,
        block_type ENUM(${DOC_BLOCK_TYPE_ENUM}) NOT NULL DEFAULT 'text',
        title VARCHAR(200) NULL,
        content TEXT NULL,
        url VARCHAR(1024) NULL,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        INDEX documentation_blocks_position_idx (position)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

      // `CREATE TABLE IF NOT EXISTS` leaves an existing table untouched, so a
      // database created before 'separator' would reject the new type. Same
      // in-place migration as field_type in services/forms.js: widen the ENUM
      // rather than ask for a manual migration step. Widening never drops an
      // existing value, so replaying it on every boot is safe.
      const [columns] = await pool.execute('SHOW COLUMNS FROM documentation_blocks');
      const rows = Array.isArray(columns) ? columns : [];
      const blockTypeColumn = rows.find((column) => column?.Field === 'block_type');
      const currentEnum = String(blockTypeColumn?.Type || '');
      const enumIsUpToDate = DOC_BLOCK_TYPE_VALUES.every((type) => currentEnum.includes(`'${type}'`));
      // A pool that cannot answer SHOW COLUMNS is not a reason to fail: a fresh
      // table already carries the full ENUM from the CREATE above.
      if (rows.length && !enumIsUpToDate) {
        await pool.execute(
          `ALTER TABLE documentation_blocks
           MODIFY COLUMN block_type ENUM(${DOC_BLOCK_TYPE_ENUM}) NOT NULL DEFAULT 'text'`,
        );
      }
    })().catch((error) => {
      initializedPools.delete(poolKey);
      throw error;
    });
    initializedPools.set(poolKey, initialization);
  }
  return initialization;
}

function mapBlock(row) {
  if (!row) return null;
  return {
    id: row.id,
    position: Number(row.position),
    blockType: row.block_type,
    title: row.title || '',
    content: row.content || '',
    url: row.url || '',
    updatedAt: row.updated_at,
  };
}

export async function listDocumentationBlocks(pool = getDatabasePool()) {
  if (!pool) return [];
  try {
    await ensureDocumentationTables(pool);
    const [rows] = await pool.execute(
      'SELECT id, position, block_type, title, content, url, updated_at FROM documentation_blocks ORDER BY position ASC, id ASC',
    );
    return rows.map(mapBlock);
  } catch (error) {
    console.error('[DocumentationService] Unable to list blocks:', error.message);
    return [];
  }
}

/**
 * Creates a block. `index` is the slot it should occupy, as counted from the top
 * of the published list, which is what the insertion points between two blocks
 * post: everything from that slot down shifts by one. Omit it to append, the way
 * the plain "add a block" form did.
 */
export async function createDocumentationBlock({
  blockType = DOC_BLOCK_TYPES.TEXT,
  title = '',
  content = '',
  url = '',
  index = null,
  pool = getDatabasePool(),
}) {
  if (!pool) return null;
  await ensureDocumentationTables(pool);

  let position;
  const wantsSlot = Number.isInteger(index) && index >= 0;
  if (wantsSlot) {
    const [rows] = await pool.execute('SELECT id, position FROM documentation_blocks ORDER BY position ASC, id ASC');
    const slot = Math.min(index, rows.length);
    // Push the tail down before inserting, so no two blocks share a position.
    if (rows.some((row) => Number(row.position) >= slot)) {
      await pool.execute('UPDATE documentation_blocks SET position = position + 1 WHERE position >= ?', [slot]);
    }
    position = slot;
  } else {
    const [positionRows] = await pool.execute(
      'SELECT COALESCE(MAX(position), -1) + 1 AS next_position FROM documentation_blocks',
    );
    position = Number(positionRows[0]?.next_position ?? 0);
  }

  const [result] = await pool.execute(
    'INSERT INTO documentation_blocks (position, block_type, title, content, url) VALUES (?, ?, ?, ?, ?)',
    [position, blockType, title || null, content || null, url || null],
  );
  return getDocumentationBlock(result.insertId, pool);
}

export async function getDocumentationBlock(blockId, pool = getDatabasePool()) {
  if (!pool || !blockId) return null;
  await ensureDocumentationTables(pool);
  const [rows] = await pool.execute(
    'SELECT id, position, block_type, title, content, url, updated_at FROM documentation_blocks WHERE id = ? LIMIT 1',
    [blockId],
  );
  return mapBlock(rows[0]);
}

export async function updateDocumentationBlock({
  blockId,
  blockType,
  title = '',
  content = '',
  url = '',
  pool = getDatabasePool(),
}) {
  if (!pool || !blockId) return null;
  await ensureDocumentationTables(pool);
  const [result] = await pool.execute(
    'UPDATE documentation_blocks SET block_type = ?, title = ?, content = ?, url = ? WHERE id = ?',
    [blockType, title || null, content || null, url || null, blockId],
  );
  if (!result.affectedRows) return null;
  return getDocumentationBlock(blockId, pool);
}

export async function deleteDocumentationBlock(blockId, pool = getDatabasePool()) {
  if (!pool || !blockId) return false;
  await ensureDocumentationTables(pool);
  const [result] = await pool.execute('DELETE FROM documentation_blocks WHERE id = ?', [blockId]);
  return Boolean(result.affectedRows);
}

/**
 * Renumbers every block from the given order, so a drag-and-drop costs one
 * request instead of one reload per step. Ids that are not numbers are dropped:
 * the list comes straight from a form post.
 */
export async function reorderDocumentationBlocks(orderedIds, pool = getDatabasePool()) {
  if (!pool || !Array.isArray(orderedIds) || !orderedIds.length) return false;
  const ids = orderedIds.map((id) => Number.parseInt(id, 10)).filter((id) => Number.isInteger(id) && id > 0);
  if (!ids.length) return false;

  await ensureDocumentationTables(pool);
  for (const [position, id] of ids.entries()) {
    await pool.execute('UPDATE documentation_blocks SET position = ? WHERE id = ?', [position, id]);
  }
  return true;
}

/**
 * Moves a block one slot up or down and renumbers the whole list so positions
 * stay dense. `direction` is -1 (up) or 1 (down).
 */
export async function moveDocumentationBlock(blockId, direction, pool = getDatabasePool()) {
  if (!pool || !blockId) return null;
  await ensureDocumentationTables(pool);
  const [rows] = await pool.execute(
    'SELECT id, position FROM documentation_blocks ORDER BY position ASC, id ASC',
  );
  const ordered = rows.map((row) => ({ id: row.id, position: Number(row.position) }));
  const index = ordered.findIndex((row) => row.id === Number(blockId));
  if (index === -1) return null;

  const target = index + (Number(direction) < 0 ? -1 : 1);
  if (target < 0 || target >= ordered.length) return ordered[index];

  const reordered = [...ordered];
  [reordered[index], reordered[target]] = [reordered[target], reordered[index]];

  for (const [position, row] of reordered.entries()) {
    if (row.position !== position) {
      await pool.execute('UPDATE documentation_blocks SET position = ? WHERE id = ?', [position, row.id]);
    }
  }
  return getDocumentationBlock(blockId, pool);
}
