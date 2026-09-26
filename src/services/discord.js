import { webConfig } from '../config.js';
import { recordDeath } from './deaths.js';

export function getDiscordCreationDate(userId) {
  try {
    const timestamp = Number((BigInt(userId) >> 22n) + 1420070400000n);
    return new Date(timestamp);
  } catch {
    return null;
  }
}

export function formatAccountAge(createdAt, now = new Date()) {
  if (!(createdAt instanceof Date) || Number.isNaN(createdAt.getTime())) return 'Inconnu';
  let years = now.getUTCFullYear() - createdAt.getUTCFullYear();
  let months = now.getUTCMonth() - createdAt.getUTCMonth();
  if (now.getUTCDate() < createdAt.getUTCDate()) months -= 1;
  if (months < 0) {
    years -= 1;
    months += 12;
  }
  return `${years} an${years > 1 ? 's' : ''}, ${months} mois`;
}

let userTimeZone = 'Europe/Paris';

export function setUserTimeZone(timeZone) {
  try {
    Intl.DateTimeFormat(undefined, { timeZone }).resolvedOptions().timeZone;
    userTimeZone = timeZone;
  } catch {
    userTimeZone = 'Europe/Paris';
  }
}

export function getUserTimeZone() {
  return userTimeZone;
}

export function formatDate(date) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) return 'Inconnue';
  return new Intl.DateTimeFormat('fr-FR', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: userTimeZone,
  }).format(date);
}

/**
 * Fetches the guild's role list via the bot token and returns a Map of
 * roleId -> role name. `fetchGuildMemberRoles` only yields role snowflakes,
 * so this is what lets the profile render a human-readable role name.
 * Cached in memory because the guild role list is near-static.
 */
const guildRoleNameCache = new Map();
const GUILD_ROLE_TTL_MS = 2 * 60 * 1000;

export async function fetchGuildRoleNames({
  guildId = webConfig.guildId,
  botToken = webConfig.discordToken,
  fetchFn = fetch,
} = {}) {
  if (!botToken || !guildId) return new Map();

  const cached = guildRoleNameCache.get(guildId);
  if (cached && cached.expires > Date.now()) return cached.names;

  try {
    const response = await fetchFn(
      `https://discord.com/api/v10/guilds/${guildId}/roles`,
      {
        headers: {
          Authorization: `Bot ${botToken}`,
        },
        signal: AbortSignal.timeout(8000),
      }
    );

    if (!response.ok) {
      console.warn(`[DiscordService] Guild roles fetch returned ${response.status} for guild ${guildId}`);
      return new Map();
    }

    const roles = await response.json();
    const names = new Map(
      (Array.isArray(roles) ? roles : [])
        .filter((role) => role && role.id && role.name)
        .map((role) => [role.id, role.name])
    );

    guildRoleNameCache.set(guildId, { names, expires: Date.now() + GUILD_ROLE_TTL_MS });
    return names;
  } catch (error) {
    console.error(`[DiscordService] Error fetching roles for guild ${guildId}:`, error.message);
    return new Map();
  }
}

export function invalidateGuildRoleCache(guildId = webConfig.guildId) {
  guildRoleNameCache.delete(guildId);
}

/**
 * Fetches the user's guild member data via Discord Bot token to inspect roles
 * without requiring the oauth guilds.members.read scope.
 */
export async function fetchGuildMemberRoles({
  userId,
  guildId = webConfig.guildId,
  botToken = webConfig.discordToken,
  fetchFn = fetch,
}) {
  if (!botToken || !guildId || !userId) {
    return {
      inGuild: false,
      roles: [],
      hasTargetRole: false,
    };
  }

  try {
    const response = await fetchFn(
      `https://discord.com/api/v10/guilds/${guildId}/members/${userId}`,
      {
        headers: {
          Authorization: `Bot ${botToken}`,
        },
        signal: AbortSignal.timeout(8000),
      }
    );

    if (response.status === 404) {
      return {
        inGuild: false,
        roles: [],
        hasTargetRole: false,
      };
    }

    if (!response.ok) {
      console.warn(`[DiscordService] Guild member fetch returned ${response.status} for user ${userId}`);
      return {
        inGuild: false,
        roles: [],
        hasTargetRole: false,
      };
    }

    const member = await response.json();
    const roles = Array.isArray(member.roles) ? member.roles : [];
    const hasTargetRole = roles.includes(webConfig.targetRoleId);

    return {
      inGuild: true,
      nickname: member.nick || null,
      roles,
      hasTargetRole,
    };
  } catch (error) {
    console.error(`[DiscordService] Error fetching member roles for ${userId}:`, error.message);
    return {
      inGuild: false,
      roles: [],
      hasTargetRole: false,
      error: error.message,
    };
  }
}

const DISCORD_API_BASE = 'https://discord.com/api/v10';

/**
 * Adds a single role to a guild member through the Bot token.
 * Used when a candidature is accepted from the web portal.
 */
export async function grantGuildMemberRole({
  userId,
  roleId,
  guildId = webConfig.guildId,
  botToken = webConfig.discordToken,
  fetchFn = fetch,
} = {}) {
  if (!userId || !roleId) {
    return { ok: false, status: 400, error: 'Identifiant utilisateur ou rôle manquant.' };
  }
  if (!botToken || !guildId) {
    return { ok: false, status: 503, error: 'Le bot Discord n’est pas configuré.' };
  }

  try {
    const response = await fetchFn(
      `${DISCORD_API_BASE}/guilds/${guildId}/members/${userId}/roles/${roleId}`,
      {
        method: 'PUT',
        headers: { Authorization: `Bot ${botToken}` },
        signal: AbortSignal.timeout(8000),
      }
    );

    if (response.status === 204 || response.ok) return { ok: true, status: response.status };
    return { ok: false, status: response.status, error: `Discord a refusé l’attribution du rôle (HTTP ${response.status}).` };
  } catch (error) {
    console.error(`[DiscordService] Error granting role ${roleId} to ${userId}:`, error.message);
    return { ok: false, status: 500, error: 'Impossible de contacter l’API Discord.' };
  }
}

/**
 * Opens a DM channel with a user and posts the given embeds.
 * Accepts ready-made discord.js embeds (or plain payload objects) so the bot
 * keeps a single source of truth for message formatting.
 */
export async function sendDirectMessage({
  userId,
  embeds = [],
  botToken = webConfig.discordToken,
  fetchFn = fetch,
} = {}) {
  if (!userId) {
    return { ok: false, status: 400, error: 'Identifiant utilisateur manquant.' };
  }
  if (!botToken) {
    return { ok: false, status: 503, error: 'Le bot Discord n’est pas configuré.' };
  }
  if (!embeds.length) {
    return { ok: false, status: 400, error: 'Aucun message à envoyer.' };
  }

  const payload = embeds.map((embed) => (typeof embed?.toJSON === 'function' ? embed.toJSON() : embed));
  const headers = {
    Authorization: `Bot ${botToken}`,
    'Content-Type': 'application/json',
  };

  try {
    const channelResponse = await fetchFn(`${DISCORD_API_BASE}/users/@me/channels`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ recipient_id: userId }),
      signal: AbortSignal.timeout(8000),
    });

    if (!channelResponse.ok) {
      console.warn(`[DiscordService] DM channel creation failed for ${userId} (HTTP ${channelResponse.status}).`);
      return { ok: false, status: channelResponse.status, error: 'Le membre n’accepte pas les messages directs.' };
    }

    const channel = await channelResponse.json();
    if (!channel?.id) {
      return { ok: false, status: 500, error: 'Réponse inattendue de l’API Discord.' };
    }

    const messageResponse = await fetchFn(`${DISCORD_API_BASE}/channels/${channel.id}/messages`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ embeds: payload }),
      signal: AbortSignal.timeout(8000),
    });

    if (!messageResponse.ok) {
      console.warn(`[DiscordService] DM send failed for ${userId} (HTTP ${messageResponse.status}).`);
      return { ok: false, status: messageResponse.status, error: 'Le message direct n’a pas pu être envoyé.' };
    }

return { ok: true, status: messageResponse.status, channelId: channel.id };
  } catch (error) {
    console.error(`[DiscordService] Error sending DM to ${userId}:`, error.message);
    return { ok: false, status: 500, error: "Impossible de contacter l'API Discord." };
  }
}

function createPermadeathDeathEmbed({ robloxUsername, eventId, context }) {
  return {
    title: '💀 Mort permanente enregistrée',
    description: 'Votre personnage est décédé en jeu (permadeath).',
    color: 0x8b0000,
    fields: [
      { name: 'Compte Roblox', value: robloxUsername || 'Inconnu', inline: true },
      ...(eventId ? [{ name: 'ID événement', value: `\`${eventId}\``, inline: true }] : []),
      ...(context ? [{ name: 'Contexte', value: context.slice(0, 1024) }] : []),
    ],
    footer: { text: 'Site-66 · Système Permadeath' },
    timestamp: new Date().toISOString(),
  };
}

export async function sendPermadeathDeathDM({
  discordUserId,
  robloxUserId,
  robloxUsername,
  eventId = null,
  context = null,
  pool,
  fetchFn = fetch,
} = {}) {
  if (!discordUserId || !robloxUserId) {
    return { ok: false, error: 'discordUserId et robloxUserId sont requis.' };
  }

  const embed = createPermadeathDeathEmbed({ robloxUsername, eventId, context });
  const dmResult = await sendDirectMessage({ userId: discordUserId, embeds: [embed], fetchFn });

  if (dmResult.ok) {
    await recordDeath({
      discordUserId,
      robloxUserId,
      eventId,
      context,
      occurredAt: new Date(),
      pool,
    });
  }

  return {
    ok: dmResult.ok,
    dmSent: dmResult.ok,
    error: dmResult.error,
  };
};
