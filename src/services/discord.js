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

const guildMemberCache = new Map();
const GUILD_MEMBER_TTL_MS = 30 * 1000;
const GUILD_MEMBER_CACHE_MAX = 500;

function readGuildMemberCache(key) {
  const cached = guildMemberCache.get(key);
  if (!cached) return null;
  if (cached.expires <= Date.now()) {
    guildMemberCache.delete(key);
    return null;
  }
  return cached.value;
}

function writeGuildMemberCache(key, value) {
  if (guildMemberCache.size >= GUILD_MEMBER_CACHE_MAX) {
    const oldest = guildMemberCache.keys().next().value;
    if (oldest !== undefined) guildMemberCache.delete(oldest);
  }
  guildMemberCache.set(key, { value, expires: Date.now() + GUILD_MEMBER_TTL_MS });
}

/**
 * Drops cached role data for a member so a freshly granted role is visible
 * immediately instead of after the cache TTL.
 */
export function invalidateGuildMemberCache(userId, guildId = webConfig.guildId) {
  if (userId) guildMemberCache.delete(`${guildId}:${userId}`);
  else guildMemberCache.clear();
}

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

  const cacheKey = `${guildId}:${userId}`;
  const cachedResult = readGuildMemberCache(cacheKey);
  if (cachedResult) return cachedResult;

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
      // Not in the guild is a stable fact: safe to cache.
      const absent = {
        inGuild: false,
        roles: [],
        hasTargetRole: false,
      };
      writeGuildMemberCache(cacheKey, absent);
      return absent;
    }

    if (!response.ok) {
      // 429 / 5xx are transient. Caching them would freeze the "no roles"
      // verdict and keep denying access after the rate limit clears.
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

    const result = {
      inGuild: true,
      nickname: member.nick || null,
      roles,
      hasTargetRole,
    };
    writeGuildMemberCache(cacheKey, result);
    return result;
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

function toDiscordAvatarUrl(user) {
  if (!user) return null;
  if (user.avatar) {
    const extension = user.avatar.startsWith('a_') ? 'gif' : 'png';
    return `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.${extension}?size=256`;
  }
  return `https://cdn.discordapp.com/embed/avatars/${Number(user.discriminator || 0) % 5}.png`;
}

/**
 * Fetches the whole guild roster in as few requests as Discord allows
 * (1000 members per call). This replaces the per-member N+1 that used to
 * exhaust the global rate limit and made the Supervision page return 429s.
 *
 * Returns `null` when the endpoint is unusable (for example when the bot
 * lacks the Guild Members intent) so callers can fall back to individual
 * lookups instead of failing.
 */
export async function fetchGuildMemberDirectory({
  guildId = webConfig.guildId,
  botToken = webConfig.discordToken,
  fetchFn = fetch,
} = {}) {
  if (!botToken || !guildId) return null;

  const directory = new Map();
  let after = null;

  try {
    for (let page = 0; page < 10; page += 1) {
      const url = `${DISCORD_API_BASE}/guilds/${guildId}/members?limit=1000${after ? `&after=${after}` : ''}`;
      const response = await fetchFn(url, {
        headers: { Authorization: `Bot ${botToken}` },
        signal: AbortSignal.timeout(8000),
      });

      if (!response.ok) {
        console.warn(`[DiscordService] Bulk guild member fetch returned ${response.status}; falling back to per-member lookups.`);
        return null;
      }

      const entries = await response.json();
      if (!Array.isArray(entries) || entries.length === 0) break;

      for (const entry of entries) {
        const user = entry?.user;
        if (!user?.id) continue;
        directory.set(user.id, {
          username: user.username,
          globalName: user.global_name || user.username,
          avatarUrl: toDiscordAvatarUrl(user),
          roles: Array.isArray(entry.roles) ? entry.roles : [],
        });
      }

      if (entries.length < 1000) break;
      after = entries[entries.length - 1]?.user?.id;
      if (!after) break;
    }

    return directory;
  } catch (error) {
    console.warn(`[DiscordService] Bulk guild member fetch failed: ${error.message}`);
    return null;
  }
}

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

    if (response.status === 204 || response.ok) {
      invalidateGuildMemberCache(userId, guildId);
      return { ok: true, status: response.status };
    }
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
