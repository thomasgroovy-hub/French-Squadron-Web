import { webConfig } from '../config.js';

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

export function formatDate(date) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) return 'Inconnue';
  return new Intl.DateTimeFormat('fr-FR', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(date);
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
