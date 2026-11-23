import { webConfig } from '../config.js';

const OPEN_CLOUD_BASE_URL = 'https://apis.roblox.com/cloud/v2';
const ROBLOX_USERS_BASE_URL = 'https://users.roblox.com/v1/users';
const ROLE_ID_PATTERN = /^\d{1,20}$/;
const ROLE_CACHE_TTL_MS = 60_000;
const MAX_ROLE_PAGES = 50;
const roleCache = new Map();

export class RobloxGroupConfigurationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'RobloxGroupConfigurationError';
  }
}

export class RobloxGroupApiError extends Error {
  constructor(message, status = null) {
    super(message);
    this.name = 'RobloxGroupApiError';
    this.status = status;
  }
}

function readConfig(config) {
  const groupId = typeof config?.robloxGroupId === 'string'
    ? config.robloxGroupId.trim()
    : '';
  const apiKey = typeof config?.robloxOpenCloudApiKey === 'string'
    ? config.robloxOpenCloudApiKey.trim()
    : '';
  const roleIds = Array.isArray(config?.robloxRequestableRoleIds)
    ? config.robloxRequestableRoleIds
    : [];

  if (!ROLE_ID_PATTERN.test(groupId)) {
    throw new RobloxGroupConfigurationError('ROBLOX_GROUP_ID is missing or invalid.');
  }
  if (!apiKey) {
    throw new RobloxGroupConfigurationError('ROBLOX_OPEN_CLOUD_API_KEY is not configured.');
  }
  if (!roleIds.length || roleIds.some((roleId) => (
    typeof roleId !== 'string' || !ROLE_ID_PATTERN.test(roleId)
  ))) {
    throw new RobloxGroupConfigurationError('ROBLOX_REQUESTABLE_ROLE_IDS is missing or invalid.');
  }

  return { groupId, apiKey, roleIds: [...new Set(roleIds)] };
}

async function requestJson(url, {
  fetchFn = fetch,
  apiKey = null,
  method = 'GET',
  body = null,
} = {}) {
  const headers = {};
  if (apiKey) headers['x-api-key'] = apiKey;
  if (body !== null) headers['content-type'] = 'application/json';

  let response;
  try {
    response = await fetchFn(url, {
      method,
      headers,
      redirect: 'error',
      ...(body === null ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(8_000),
    });
  } catch (error) {
    throw new RobloxGroupApiError(`Roblox request failed: ${error.message}`);
  }

  if (!response?.ok) {
    const status = Number.isInteger(response?.status) ? response.status : null;
    const detail = status === 401
      ? 'Roblox rejected the configured Open Cloud key.'
      : status === 403
        ? 'Roblox denied the request; check the key scopes and group role hierarchy.'
        : 'Roblox could not complete the request.';
    throw new RobloxGroupApiError(
      `${detail}${status ? ` (HTTP ${status})` : ''}`,
      status,
    );
  }

  if (response.status === 204) return null;
  try {
    return await response.json();
  } catch {
    throw new RobloxGroupApiError('Roblox returned an invalid response.');
  }
}

export async function getRequestableRobloxGroupRoles({
  config = webConfig,
  fetchFn = fetch,
  forceRefresh = false,
} = {}) {
  const { groupId, apiKey, roleIds } = readConfig(config);
  const cacheKey = `${groupId}:${[...roleIds].sort().join(',')}`;
  const cached = roleCache.get(cacheKey);
  if (!forceRefresh && cached && cached.expiresAt > Date.now()) return cached.roles;

  const rolesById = new Map();
  let pageToken = null;
  let pageCount = 0;

  do {
    if (pageCount >= MAX_ROLE_PAGES) {
      throw new RobloxGroupApiError('Roblox returned too many role pages.');
    }

    const url = new URL(`${OPEN_CLOUD_BASE_URL}/groups/${groupId}/roles`);
    url.searchParams.set('maxPageSize', '20');
    if (pageToken) url.searchParams.set('pageToken', pageToken);

    const data = await requestJson(url, { fetchFn, apiKey });
    if (!Array.isArray(data?.groupRoles)) {
      throw new RobloxGroupApiError('Roblox returned an invalid group role list.');
    }

    for (const role of data.groupRoles) {
      const id = typeof role?.id === 'string' ? role.id : '';
      const name = typeof role?.displayName === 'string' ? role.displayName : '';
      if (ROLE_ID_PATTERN.test(id) && name && roleIds.includes(id)) {
        rolesById.set(id, { id, name });
      }
    }

    pageToken = typeof data.nextPageToken === 'string' && data.nextPageToken
      ? data.nextPageToken
      : null;
    pageCount += 1;
  } while (pageToken);

  const roles = roleIds
    .map((id) => rolesById.get(id))
    .filter(Boolean);
  if (!roles.length) {
    throw new RobloxGroupConfigurationError(
      'ROBLOX_REQUESTABLE_ROLE_IDS does not match any current role in the configured group.',
    );
  }

  roleCache.set(cacheKey, { roles, expiresAt: Date.now() + ROLE_CACHE_TTL_MS });
  return roles;
}

export async function getVerifiedRobloxLink(discordUserId, { sitePool } = {}) {
  if (!sitePool || typeof sitePool.execute !== 'function') {
    throw new RobloxGroupConfigurationError('The verified Roblox link database is unavailable.');
  }

  const [rows] = await sitePool.execute(
    'SELECT discord_user_id, roblox_user_id, roblox_username FROM roblox_links WHERE discord_user_id = ? LIMIT 1',
    [discordUserId],
  );
  const link = rows?.[0];
  if (!link) return null;

  const robloxUserId = String(link.roblox_user_id ?? '');
  if (!ROLE_ID_PATTERN.test(robloxUserId)) {
    throw new RobloxGroupApiError('The verified Roblox link contains an invalid user ID.');
  }

  return {
    discordUserId: String(link.discord_user_id),
    robloxUserId,
    robloxUsername: typeof link.roblox_username === 'string' ? link.roblox_username : null,
  };
}

export async function applyRequestedRobloxGroupRole({
  applicantDiscordId,
  requestedRoleId,
  sitePool,
  config = webConfig,
  fetchFn = fetch,
} = {}) {
  if (typeof requestedRoleId !== 'string' || !ROLE_ID_PATTERN.test(requestedRoleId)) {
    throw new RobloxGroupConfigurationError('The requested Roblox role ID is invalid.');
  }

  const { groupId, apiKey } = readConfig(config);
  const roles = await getRequestableRobloxGroupRoles({ config, fetchFn, forceRefresh: true });
  const role = roles.find((item) => item.id === requestedRoleId);
  if (!role) {
    throw new RobloxGroupConfigurationError(
      'The requested Roblox role is no longer configured for this group.',
    );
  }

  const link = await getVerifiedRobloxLink(applicantDiscordId, { sitePool });
  if (!link) {
    throw new RobloxGroupConfigurationError('The applicant does not have a verified Roblox account link.');
  }

  const profile = await requestJson(
    `${ROBLOX_USERS_BASE_URL}/${link.robloxUserId}`,
    { fetchFn },
  );
  if (String(profile?.id ?? '') !== link.robloxUserId) {
    throw new RobloxGroupApiError('The linked Roblox user could not be verified.');
  }

  const membershipUrl = new URL(`${OPEN_CLOUD_BASE_URL}/groups/${groupId}/memberships`);
  membershipUrl.searchParams.set('maxPageSize', '1');
  membershipUrl.searchParams.set('filter', `user == 'users/${link.robloxUserId}'`);
  const membershipData = await requestJson(membershipUrl, { fetchFn, apiKey });
  const membership = Array.isArray(membershipData?.groupMemberships)
    ? membershipData.groupMemberships.find((item) => item?.user === `users/${link.robloxUserId}`)
    : null;
  if (!membership) {
    throw new RobloxGroupApiError('The linked Roblox account is not a member of the configured group.');
  }

  const membershipMatch = typeof membership.path === 'string'
    ? membership.path.match(new RegExp(`^groups/${groupId}/memberships/([A-Za-z0-9_-]+)$`))
    : null;
  if (!membershipMatch) {
    throw new RobloxGroupApiError('Roblox returned an invalid group membership resource.');
  }

  const rolePath = `groups/${groupId}/roles/${requestedRoleId}`;
  const assignedRoles = Array.isArray(membership.roles) ? membership.roles : [];
  if (membership.role === rolePath || assignedRoles.includes(rolePath)) {
    return { status: 'already-assigned', roleId: role.id, roleName: role.name };
  }

  await requestJson(
    `${OPEN_CLOUD_BASE_URL}/groups/${groupId}/memberships/${membershipMatch[1]}:assignRole`,
    {
      fetchFn,
      apiKey,
      method: 'POST',
      body: { role: rolePath },
    },
  );

  return { status: 'assigned', roleId: role.id, roleName: role.name };
}
