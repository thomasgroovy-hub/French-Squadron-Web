import { getDatabasePool } from '../database.js';

const initializedPools = new WeakMap();

async function ensureSiteUsersTable(pool) {
  let initialization = initializedPools.get(pool);
  if (!initialization) {
    initialization = pool.execute(`
      CREATE TABLE IF NOT EXISTS site_users (
        discord_user_id VARCHAR(20) NOT NULL PRIMARY KEY,
        discord_username VARCHAR(32) NOT NULL,
        global_name VARCHAR(64) NOT NULL,
        avatar_url VARCHAR(512) NOT NULL,
        first_login DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        last_login DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        INDEX site_users_last_login_idx (last_login)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `).catch((error) => {
      initializedPools.delete(pool);
      throw error;
    });
    initializedPools.set(pool, initialization);
  }
  await initialization;
}

export async function recordSiteLogin(user, pool = getDatabasePool()) {
  if (!pool || !user?.id) return false;
  try {
    await ensureSiteUsersTable(pool);
    await pool.execute(
      `INSERT INTO site_users
        (discord_user_id, discord_username, global_name, avatar_url)
       VALUES (?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         discord_username = VALUES(discord_username),
         global_name = VALUES(global_name),
         avatar_url = VALUES(avatar_url),
         last_login = CURRENT_TIMESTAMP`,
      [user.id, user.username, user.globalName || user.username, user.avatarUrl],
    );
    return true;
  } catch (error) {
    console.error('[MembersService] Unable to record site login:', error.message);
    return false;
  }
}

export async function fetchSiteUsers(search = '', pool = getDatabasePool()) {
  if (!pool) return [];
  try {
    await ensureSiteUsersTable(pool);
    const term = `%${search.trim()}%`;
    const [rows] = await pool.execute(
      `SELECT users.discord_user_id, users.discord_username, users.global_name,
              users.avatar_url, users.last_login, links.roblox_username
       FROM site_users AS users
       LEFT JOIN roblox_discord_links AS links
         ON links.discord_user_id = users.discord_user_id
       WHERE ? = '%%'
          OR users.discord_username LIKE ?
          OR users.global_name LIKE ?
          OR links.roblox_username LIKE ?
       ORDER BY users.last_login DESC`,
      [term, term, term, term],
    );
    return rows;
  } catch (error) {
    console.error('[MembersService] Unable to fetch site users:', error.message);
    return [];
  }
}

export async function fetchSiteUser(discordUserId, pool = getDatabasePool()) {
  if (!pool || !discordUserId) return null;
  try {
    await ensureSiteUsersTable(pool);
    const [rows] = await pool.execute(
      `SELECT users.discord_user_id, users.discord_username, users.global_name,
              users.avatar_url, users.last_login, links.roblox_username
       FROM site_users AS users
       LEFT JOIN roblox_discord_links AS links
         ON links.discord_user_id = users.discord_user_id
       WHERE users.discord_user_id = ?
       LIMIT 1`,
      [discordUserId],
    );
    return rows[0] || null;
  } catch (error) {
    console.error('[MembersService] Unable to fetch site user:', error.message);
    return null;
  }
}