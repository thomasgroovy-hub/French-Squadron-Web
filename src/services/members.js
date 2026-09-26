import { getDatabasePool, getSiteDatabasePool } from '../database.js';
import { webConfig } from '../config.js';

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

async function fetchDiscordUserViaBot(userId, { botToken = webConfig.discordToken, fetchFn = fetch } = {}) {
  if (!botToken || !userId) return null;
  try {
    const response = await fetchFn(`https://discord.com/api/v10/users/${userId}`, {
      headers: { Authorization: `Bot ${botToken}` },
      signal: AbortSignal.timeout(8000),
    });
    if (!response.ok) return null;
    const user = await response.json();
    return {
      id: user.id,
      username: user.username,
      globalName: user.global_name || user.username,
      avatarUrl: user.avatar
        ? `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.${user.avatar.startsWith('a_') ? 'gif' : 'png'}?size=256`
        : `https://cdn.discordapp.com/embed/avatars/${Number(user.discriminator || 0) % 5}.png`,
    };
  } catch (error) {
    console.error(`[MembersService] Failed to fetch Discord user ${userId} via bot:`, error.message);
    return null;
  }
}

export async function fetchAllLinkedMembers(search = '', { pool = getDatabasePool(), sitePool = getSiteDatabasePool(), fetchFn = fetch } = {}) {
  const readPool = sitePool || pool;
  if (!readPool) return [];
  try {
    const term = `%${search.trim()}%`;
    const [rows] = await readPool.execute(
      `SELECT
         links.discord_user_id,
         links.roblox_user_id,
         links.roblox_username,
         links.verification_rank,
         links.verified_at
       FROM roblox_links AS links
       WHERE ? = '%%'
          OR links.discord_user_id LIKE ?
          OR links.roblox_username LIKE ?
       ORDER BY links.verified_at DESC`,
      [term, term, term],
    );

    const members = [];
    for (const row of rows) {
      const discordUser = await fetchDiscordUserViaBot(row.discord_user_id, { fetchFn });
      members.push({
        discord_user_id: row.discord_user_id,
        discord_username: discordUser?.username || 'Inconnu',
        global_name: discordUser?.globalName || 'Inconnu',
        avatar_url: discordUser?.avatarUrl || `https://cdn.discordapp.com/embed/avatars/${Number(row.discord_user_id.slice(-1)) % 5}.png`,
        last_login: null,
        roblox_username: row.roblox_username,
        roblox_user_id: row.roblox_user_id,
        verification_rank: row.verification_rank,
        verified_at: row.verified_at,
        hasSiteSession: false,
      });
    }
    return members;
  } catch (error) {
    console.error('[MembersService] Unable to fetch all linked members:', error.message);
    return [];
  }
}

export async function fetchLinkedMember(discordUserId, { pool = getDatabasePool(), sitePool = getSiteDatabasePool(), fetchFn = fetch } = {}) {
  const readPool = sitePool || pool;
  if (!readPool || !discordUserId) return null;
  try {
    const [rows] = await readPool.execute(
      `SELECT
         links.discord_user_id,
         links.roblox_user_id,
         links.roblox_username,
         links.verification_rank,
         links.verified_at
       FROM roblox_links AS links
       WHERE links.discord_user_id = ?
       LIMIT 1`,
      [discordUserId],
    );
    if (!rows[0]) return null;

    const row = rows[0];
    const discordUser = await fetchDiscordUserViaBot(row.discord_user_id, { fetchFn });
    return {
      discord_user_id: row.discord_user_id,
      discord_username: discordUser?.username || 'Inconnu',
      global_name: discordUser?.globalName || 'Inconnu',
      avatar_url: discordUser?.avatarUrl || `https://cdn.discordapp.com/embed/avatars/${Number(row.discord_user_id.slice(-1)) % 5}.png`,
      last_login: null,
      roblox_username: row.roblox_username,
      roblox_user_id: row.roblox_user_id,
      verification_rank: row.verification_rank,
      verified_at: row.verified_at,
      hasSiteSession: false,
    };
  } catch (error) {
    console.error('[MembersService] Unable to fetch linked member:', error.message);
    return null;
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
       LEFT JOIN roblox_links AS links
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
       LEFT JOIN roblox_links AS links
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