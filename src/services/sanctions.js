import { getDatabasePool } from '../database.js';
import { formatDate } from './discord.js';

const STRIKE_TABLE = 'strikes';
const MAX_REASON_LENGTH = 1000;
const DISCORD_ID_PATTERN = /^\d{17,20}$/;

function isValidDiscordId(value) {
  return typeof value === 'string' && DISCORD_ID_PATTERN.test(value);
}

function normalizeReason(value) {
  return typeof value === 'string' ? value.trim().slice(0, MAX_REASON_LENGTH) : '';
}

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

/**
 * The `strikes` table is shared with the Discord bot: both sides point at the
 * same main pool, so anything written here is visible to the bot's moderation
 * commands and its log channel on the next read. No replication step exists,
 * and none is needed.
 */
export async function createStrike(
  { discordUserId, moderatorId, reason },
  pool = getDatabasePool(),
) {
  if (!pool) return { ok: false, error: 'database-unavailable' };
  if (!isValidDiscordId(discordUserId)) return { ok: false, error: 'invalid-target' };
  if (!isValidDiscordId(moderatorId)) return { ok: false, error: 'invalid-moderator' };

  const cleanReason = normalizeReason(reason);
  if (!cleanReason) return { ok: false, error: 'empty-reason' };

  try {
    const [result] = await pool.execute(
      `INSERT INTO ${STRIKE_TABLE} (discord_id, moderator_discord_id, raison)
       VALUES (?, ?, ?)`,
      [discordUserId, moderatorId, cleanReason],
    );
    return { ok: true, id: result.insertId };
  } catch (error) {
    console.error('[SanctionsService] Error creating strike:', error.message);
    return { ok: false, error: 'insert-failed' };
  }
}

/**
 * Rewrites the reason of an existing strike. The original author is preserved
 * on purpose: an edited warning still belongs to the moderator who issued it.
 */
export async function updateStrikeReason({ strikeId, reason }, pool = getDatabasePool()) {
  if (!pool) return { ok: false, error: 'database-unavailable' };

  const id = Number.parseInt(strikeId, 10);
  if (!Number.isSafeInteger(id) || id <= 0) return { ok: false, error: 'invalid-strike' };

  const cleanReason = normalizeReason(reason);
  if (!cleanReason) return { ok: false, error: 'empty-reason' };

  try {
    const [result] = await pool.execute(
      `UPDATE ${STRIKE_TABLE} SET raison = ? WHERE id = ?`,
      [cleanReason, id],
    );
    if (!result.affectedRows) return { ok: false, error: 'not-found' };
    return { ok: true, id };
  } catch (error) {
    console.error('[SanctionsService] Error updating strike:', error.message);
    return { ok: false, error: 'update-failed' };
  }
}

export async function deleteStrike({ strikeId }, pool = getDatabasePool()) {
  if (!pool) return { ok: false, error: 'database-unavailable' };

  const id = Number.parseInt(strikeId, 10);
  if (!Number.isSafeInteger(id) || id <= 0) return { ok: false, error: 'invalid-strike' };

  try {
    const [result] = await pool.execute(
      `DELETE FROM ${STRIKE_TABLE} WHERE id = ?`,
      [id],
    );
    if (!result.affectedRows) return { ok: false, error: 'not-found' };
    return { ok: true, id };
  } catch (error) {
    console.error('[SanctionsService] Error deleting strike:', error.message);
    return { ok: false, error: 'delete-failed' };
  }
}

export const STRIKE_ERROR_MESSAGES = Object.freeze({
  'database-unavailable': 'La base de données est indisponible.',
  'invalid-target': 'Identifiant de membre invalide.',
  'invalid-moderator': 'Identifiant de modérateur invalide.',
  'invalid-strike': 'Avertissement introuvable.',
  'empty-reason': 'La raison est obligatoire.',
  'not-found': 'Cet avertissement n’existe plus.',
  'insert-failed': 'Impossible d’enregistrer l’avertissement.',
  'update-failed': 'Impossible de modifier l’avertissement.',
  'delete-failed': 'Impossible de supprimer l’avertissement.',
});
