import { getDatabasePool } from '../database.js';

export const STRIKE_EVENTS_TABLE = 'strike_events';

export const STRIKE_ACTIONS = Object.freeze({
  CREATED: 'created',
  UPDATED: 'updated',
  DELETED: 'deleted',
});

const MAX_REASON_LENGTH = 1000;
const VALID_ACTIONS = new Set(Object.values(STRIKE_ACTIONS));

const tableState = new WeakMap();

function truncate(value) {
  if (value === null || value === undefined) return null;
  const text = String(value);
  return text ? text.slice(0, MAX_REASON_LENGTH) : null;
}

/**
 * Append-only audit log for strike changes.
 *
 * The `strikes` table alone cannot drive a Discord notification: a removal
 * leaves no row behind, and an edit overwrites `raison` in place, so polling
 * the table can detect neither. Every mutation therefore appends one immutable
 * row here, and the bot relays whatever has not been relayed yet. The log
 * survives the site or the bot being down, and the acting user is recorded at
 * write time because only the site knows who pressed the button.
 */
export async function ensureStrikeEventsTable(pool) {
  if (!pool || typeof pool.query !== 'function') return false;

  let state = tableState.get(pool);
  if (!state) {
    state = { ready: false, initialization: null };
    tableState.set(pool, state);
  }
  if (state.ready) return true;
  if (state.initialization) return state.initialization;

  state.initialization = (async () => {
    try {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS ${STRIKE_EVENTS_TABLE} (
          id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
          strike_id BIGINT UNSIGNED NULL,
          action ENUM('created', 'updated', 'deleted') NOT NULL,
          target_discord_id VARCHAR(20) NOT NULL,
          target_name VARCHAR(80) NULL,
          actor_discord_id VARCHAR(20) NOT NULL,
          actor_name VARCHAR(80) NULL,
          previous_reason VARCHAR(${MAX_REASON_LENGTH}) NULL,
          new_reason VARCHAR(${MAX_REASON_LENGTH}) NULL,
          created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          relayed_at DATETIME NULL,
          INDEX strike_events_pending_idx (relayed_at, id),
          INDEX strike_events_target_idx (target_discord_id),
          INDEX strike_events_actor_idx (actor_discord_id)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
      `);
      state.ready = true;
      return true;
    } catch (error) {
      console.error('[StrikeEvents] Impossible de créer la table des audits:', error.message);
      return false;
    } finally {
      state.initialization = null;
    }
  })();

  return state.initialization;
}

/**
 * Records one strike change. Never throws: a failed audit line must not roll
 * back a sanction a staff member already applied, it only means the Discord
 * relay stays silent. Callers therefore ignore the return value.
 */
export async function recordStrikeEvent(
  {
    strikeId = null,
    action,
    targetDiscordId,
    targetName = null,
    actorDiscordId,
    actorName = null,
    previousReason = null,
    newReason = null,
  } = {},
  pool = getDatabasePool(),
) {
  if (!pool) return false;
  if (!VALID_ACTIONS.has(action)) return false;
  if (!targetDiscordId || !actorDiscordId) return false;

  try {
    if (!(await ensureStrikeEventsTable(pool))) return false;

    await pool.execute(
      `INSERT INTO ${STRIKE_EVENTS_TABLE}
         (strike_id, action, target_discord_id, target_name, actor_discord_id, actor_name, previous_reason, new_reason)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        strikeId ?? null,
        action,
        targetDiscordId,
        truncate(targetName),
        actorDiscordId,
        truncate(actorName),
        truncate(previousReason),
        truncate(newReason),
      ],
    );
    return true;
  } catch (error) {
    console.error('[StrikeEvents] Audit d’un avertissement impossible:', error.message);
    return false;
  }
}
