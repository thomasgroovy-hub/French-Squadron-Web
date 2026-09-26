import { getDatabasePool } from '../database.js';
import { formatDate } from './discord.js';

const initializedPools = new Map();

function getPoolKey(pool) {
  const config = pool.config || pool._config || {};
  return `${config.host}:${config.database}`;
}

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
    `).catch((error) => {
      initializedPools.delete(poolKey);
      throw error;
    });
    initializedPools.set(poolKey, initialization);
  }
  await initialization;
}

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
    await pool.execute(
      `INSERT INTO permadeath_deaths (discord_user_id, roblox_user_id, event_id, context, occurred_at)
       VALUES (?, ?, ?, ?, ?)`,
      [discordUserId, robloxUserId, eventId, context, occurredAt],
    );
    return true;
  } catch (error) {
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