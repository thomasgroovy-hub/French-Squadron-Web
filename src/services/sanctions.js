import { getDatabasePool } from '../database.js';
import { formatDate } from './discord.js';

export async function fetchMemberSanctions(discordUserId, pool = getDatabasePool()) {
  if (!pool || !discordUserId) {
    return {
      strikes: [],
      cases: [],
      bans: [],
      totalCount: 0,
    };
  }

  let strikes = [];
  let cases = [];
  let bans = [];

  try {
    const [strikeRows] = await pool.execute(
      `SELECT id, moderator_discord_id, raison, created_at
       FROM strikes
       WHERE discord_id = ?
       ORDER BY created_at DESC`,
      [discordUserId]
    );
    strikes = strikeRows.map((row) => ({
      id: row.id,
      moderatorId: row.moderator_discord_id,
      reason: row.raison || 'Non renseignée',
      createdAt: row.created_at,
      formattedDate: formatDate(new Date(row.created_at)),
      timestamp: Math.floor(new Date(row.created_at).getTime() / 1000),
    }));
  } catch (error) {
    console.error(`[SanctionsService] Error querying strikes for ${discordUserId}:`, error.message);
  }

  try {
    const [caseRows] = await pool.execute(
      `SELECT id, type, moderator_discord_id, raison, created_at
       FROM moderation_cases
       WHERE discord_id = ?
       ORDER BY created_at DESC`,
      [discordUserId]
    );
    cases = caseRows.map((row) => ({
      id: row.id,
      type: row.type,
      moderatorId: row.moderator_discord_id,
      reason: row.raison || 'Non renseignée',
      createdAt: row.created_at,
      formattedDate: formatDate(new Date(row.created_at)),
      timestamp: Math.floor(new Date(row.created_at).getTime() / 1000),
    }));
  } catch {
    // If moderation_cases table does not exist or fails, safe fallback
  }

  try {
    const [banRows] = await pool.execute(
      `SELECT guild_id, guild_name, banned_at
       FROM moderation_bans
       WHERE discord_id = ?
       ORDER BY banned_at DESC`,
      [discordUserId]
    );
    bans = banRows.map((row) => ({
      guildId: row.guild_id,
      guildName: row.guild_name,
      bannedAt: row.banned_at,
      formattedDate: formatDate(new Date(row.banned_at)),
    }));
  } catch {
    // If moderation_bans table does not exist or fails, safe fallback
  }

  return {
    strikes,
    cases,
    bans,
    totalCount: strikes.length + cases.length + bans.length,
  };
}
