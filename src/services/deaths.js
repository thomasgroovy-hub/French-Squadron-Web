import { getDatabasePool, getPoolKey } from '../database.js';
import { formatDate } from './discord.js';

const initializedPools = new Map();

async function ensurePermadeathDeathsTable(pool) {
  const poolKey = getPoolKey(pool);
  let initialization = initializedPools.get(poolKey);
  if (!initialization) {
    initialization = pool.execute(`
      CREATE TABLE IF NOT EXISTS permadeath_deaths (
        id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
        discord_user_id VARCHAR(20) NOT NULL,
        roblox_user_id VARCHAR(20) NOT NULL,
        event_id VARCHAR(64) NULL,
        context TEXT NULL,
        occurred_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        INDEX permadeath_deaths_discord_idx (discord_user_id),
        INDEX permadeath_deaths_roblox_idx (roblox_user_id),
        INDEX permadeath_deaths_occurred_idx (occurred_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `)
      // Tables created before replay protection existed keep their old shape:
      // ADD UNIQUE is the only way to retrofit the key, and it fails when the
      // legacy data already holds duplicates. Neither outcome may block boot —
      // the application-level dedupe below still applies in that case.
      .then(() => pool.execute(
        'ALTER TABLE permadeath_deaths ADD UNIQUE KEY permadeath_deaths_event_idx (event_id)',
      ))
      .catch((error) => {
        const ignored = ['ER_DUP_KEYNAME', 'ER_DUP_ENTRY'];
        if (error?.code && ignored.includes(error.code)) return [];
        initializedPools.delete(poolKey);
        throw error;
      });
    initializedPools.set(poolKey, initialization);
  }
  await initialization;
}

/**
 * Returns 'duplicate' (still a success) when the event id was already
 * recorded: a replayed webhook delivery must be idempotent, not an error.
 */
export async function recordDeath({
  discordUserId,
  robloxUserId,
  eventId = null,
  context = null,
  occurredAt = new Date(),
  pool = getDatabasePool(),
}) {
  if (!pool || !discordUserId || !robloxUserId) return false;
  try {
    await ensurePermadeathDeathsTable(pool);
    if (eventId) {
      const [existing] = await pool.execute(
        'SELECT 1 FROM permadeath_deaths WHERE event_id = ? LIMIT 1',
        [eventId],
      );
      if (existing.length) return 'duplicate';
    }
    await pool.execute(
      `INSERT INTO permadeath_deaths (discord_user_id, roblox_user_id, event_id, context, occurred_at)
       VALUES (?, ?, ?, ?, ?)`,
      [discordUserId, robloxUserId, eventId, context, occurredAt],
    );
    return true;
  } catch (error) {
    // Unique-key violation = the event was recorded by a concurrent request.
    if (error?.code === 'ER_DUP_ENTRY') return 'duplicate';
    console.error('[DeathsService] Unable to record death:', error.message);
    return false;
  }
}

export { ensurePermadeathDeathsTable };

export async function fetchMemberDeaths(discordUserId, pool = getDatabasePool(), { isStaff = false } = {}) {
  if (!pool || !discordUserId) return [];
  if (!isStaff) return [];
  try {
    await ensurePermadeathDeathsTable(pool);
    const [rows] = await pool.execute(
      `SELECT id, discord_user_id, roblox_user_id, event_id, context, occurred_at
       FROM permadeath_deaths
       WHERE discord_user_id = ?
       ORDER BY occurred_at DESC`,
      [discordUserId],
    );
    return rows.map((row) => ({
      id: row.id,
      discordUserId: row.discord_user_id,
      robloxUserId: row.roblox_user_id,
      eventId: row.event_id,
      context: row.context,
      occurredAt: row.occurred_at,
      formattedDate: formatDate(new Date(row.occurred_at)),
    }));
  } catch (error) {
    console.error(`[DeathsService] Error fetching deaths for ${discordUserId}:`, error.message);
    return [];
  }
}