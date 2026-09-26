import { getDatabasePool, getSiteDatabasePool } from '../database.js';
import { formatAccountAge, formatDate } from './discord.js';

const CACHE_TTL_MS = 5 * 60 * 1000;
const profileCache = new Map();

/**
 * Searches for a linked Roblox account for a given Discord user ID in MySQL.
 * Uses the site's database pool to read from the mirrored roblox_links table.
 */
async function getRobloxLink(discordUserId, { pool = getDatabasePool(), sitePool = getSiteDatabasePool() } = {}) {
  // Prefer site pool for reading mirror table, fallback to main pool
  const readPool = sitePool || pool;
  if (!readPool || !discordUserId) return null;

  try {
    const [rows] = await readPool.execute(
      'SELECT discord_user_id, roblox_user_id, roblox_username, verification_rank, verified_at FROM roblox_links WHERE discord_user_id = ? LIMIT 1',
      [discordUserId]
    );
    return rows[0] || null;
  } catch (error) {
    console.error(`[RobloxService] Database lookup error for ${discordUserId}:`, error.message);
    return null;
  }
}

/**
 * Fetches Roblox profile data (username, created date, bio).
 */
async function fetchRobloxProfile(robloxUserId, fetchFn = fetch) {
  const cached = profileCache.get(String(robloxUserId));
  if (cached && cached.expires > Date.now()) {
    return cached.data;
  }

  try {
    const response = await fetchFn(`https://users.roblox.com/v1/users/${robloxUserId}`, {
      signal: AbortSignal.timeout(6000),
    });

    if (!response.ok) {
      console.warn(`[RobloxService] Roblox user API returned ${response.status} for ${robloxUserId}`);
      return null;
    }

    const data = await response.json();
    profileCache.set(String(robloxUserId), {
      data,
      expires: Date.now() + CACHE_TTL_MS,
    });
    return data;
  } catch (error) {
    console.error(`[RobloxService] Failed to fetch Roblox profile for ${robloxUserId}:`, error.message);
    return null;
  }
}

/**
 * Fetches Roblox avatar headshot thumbnail.
 */
async function fetchRobloxAvatar(robloxUserId, fetchFn = fetch) {
  try {
    const response = await fetchFn(
      `https://thumbnails.roblox.com/v1/users/avatar-headshot?userIds=${robloxUserId}&size=150x150&format=Png&isCircular=false`,
      {
        signal: AbortSignal.timeout(6000),
      }
    );

    if (!response.ok) return null;
    const data = await response.json();
    return data.data?.[0]?.imageUrl || null;
  } catch (error) {
    console.error(`[RobloxService] Failed to fetch Roblox avatar for ${robloxUserId}:`, error.message);
    return null;
  }
}

/**
 * Aggregates linked Roblox information with rich profile and avatar data.
 */
export async function getLinkedRobloxData(discordUserId, { pool = getDatabasePool(), sitePool = getSiteDatabasePool(), fetchFn = fetch } = {}) {
  const link = await getRobloxLink(discordUserId, { pool, sitePool });
  if (!link) {
    return {
      isLinked: false,
      data: null,
    };
  }

  const [profile, avatarUrl] = await Promise.all([
    fetchRobloxProfile(link.roblox_user_id, fetchFn),
    fetchRobloxAvatar(link.roblox_user_id, fetchFn),
  ]);

  const createdAt = profile?.created ? new Date(profile.created) : null;
  const verifiedAt = link.verified_at ? new Date(link.verified_at) : null;

  return {
    isLinked: true,
    data: {
      userId: String(link.roblox_user_id),
      username: profile?.name || link.roblox_username,
      displayName: profile?.displayName || profile?.name || link.roblox_username,
      createdAt,
      formattedCreatedAt: formatDate(createdAt),
      accountAge: formatAccountAge(createdAt),
      avatarUrl: avatarUrl || 'https://tr.rbxcdn.com/150/150/AvatarHeadshot/Png/noFilter',
      rank: link.verification_rank || null,
      verifiedAt,
      formattedVerifiedAt: formatDate(verifiedAt),
    },
  };
}
