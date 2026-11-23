import './helpers/env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyRequestedRobloxGroupRole,
  getRequestableRobloxGroupRoles,
  RobloxGroupApiError,
  RobloxGroupConfigurationError,
} from '../src/services/roblox-group-ranks.js';

function config(groupId, roleIds = ['420001']) {
  return {
    robloxGroupId: groupId,
    robloxOpenCloudApiKey: 'mock-open-cloud-key',
    robloxRequestableRoleIds: roleIds,
  };
}

function jsonResponse(data, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => data,
  };
}

function linkedSitePool() {
  return {
    async execute(_sql, params) {
      assert.deepEqual(params, ['discord-candidate']);
      return [[{
        discord_user_id: 'discord-candidate',
        roblox_user_id: '420010',
        roblox_username: 'Candidate',
      }]];
    },
  };
}

test('group role choices come from Roblox and are restricted to configured real role IDs', async () => {
  const calls = [];
  const roles = await getRequestableRobloxGroupRoles({
    config: config('420100', ['420001']),
    fetchFn: async (url, options) => {
      calls.push({ url: String(url), options });
      return jsonResponse({
        groupRoles: [
          { id: '420001', displayName: 'Pilote' },
          { id: '420002', displayName: 'Administrateur' },
        ],
      });
    },
  });

  assert.deepEqual(roles, [{ id: '420001', name: 'Pilote' }]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.headers['x-api-key'], 'mock-open-cloud-key');
  assert.match(calls[0].url, /\/groups\/420100\/roles/);
});

test('missing Open Cloud configuration fails explicitly without making a request', async () => {
  let calls = 0;
  await assert.rejects(
    getRequestableRobloxGroupRoles({
      config: { robloxGroupId: null, robloxOpenCloudApiKey: null, robloxRequestableRoleIds: [] },
      fetchFn: async () => { calls += 1; },
    }),
    RobloxGroupConfigurationError,
  );
  assert.equal(calls, 0);
});

test('assignment verifies the linked user and group membership and runs only the authorized assignRole operation', async () => {
  const calls = [];
  const result = await applyRequestedRobloxGroupRole({
    applicantDiscordId: 'discord-candidate',
    requestedRoleId: '420001',
    sitePool: linkedSitePool(),
    config: config('420200'),
    fetchFn: async (url, options) => {
      const requestUrl = new URL(String(url));
      calls.push({ requestUrl, options });

      if (requestUrl.pathname.endsWith('/roles')) {
        return jsonResponse({ groupRoles: [{ id: '420001', displayName: 'Pilote' }] });
      }
      if (requestUrl.hostname === 'users.roblox.com') {
        assert.equal(options.headers['x-api-key'], undefined);
        return jsonResponse({ id: 420010, name: 'Candidate' });
      }
      if (requestUrl.pathname.endsWith('/memberships')) {
        assert.equal(requestUrl.searchParams.get('filter'), "user == 'users/420010'");
        return jsonResponse({
          groupMemberships: [{
            path: 'groups/420200/memberships/420020',
            user: 'users/420010',
            role: 'groups/420200/roles/1',
          }],
        });
      }
      if (requestUrl.pathname.endsWith(':assignRole')) {
        assert.equal(options.method, 'POST');
        assert.equal(options.headers['x-api-key'], 'mock-open-cloud-key');
        assert.deepEqual(JSON.parse(options.body), { role: 'groups/420200/roles/420001' });
        return jsonResponse(null, 204);
      }
      throw new Error(`Unexpected request: ${requestUrl}`);
    },
  });

  assert.deepEqual(result, { status: 'assigned', roleId: '420001', roleName: 'Pilote' });
  assert.equal(calls.filter(({ requestUrl }) => requestUrl.pathname.endsWith(':assignRole')).length, 1);
});

test('membership and Open Cloud permission failures stop the assignment', async () => {
  const noMembership = async (url) => {
    const requestUrl = new URL(String(url));
    if (requestUrl.pathname.endsWith('/roles')) {
      return jsonResponse({ groupRoles: [{ id: '420001', displayName: 'Pilote' }] });
    }
    if (requestUrl.hostname === 'users.roblox.com') return jsonResponse({ id: 420010 });
    if (requestUrl.pathname.endsWith('/memberships')) return jsonResponse({ groupMemberships: [] });
    throw new Error('assignRole must not be reached');
  };

  await assert.rejects(
    applyRequestedRobloxGroupRole({
      applicantDiscordId: 'discord-candidate',
      requestedRoleId: '420001',
      sitePool: linkedSitePool(),
      config: config('420300'),
      fetchFn: noMembership,
    }),
    /not a member/,
  );

  const forbiddenAssignment = async (url) => {
    const requestUrl = new URL(String(url));
    if (requestUrl.pathname.endsWith('/roles')) {
      return jsonResponse({ groupRoles: [{ id: '420001', displayName: 'Pilote' }] });
    }
    if (requestUrl.hostname === 'users.roblox.com') return jsonResponse({ id: 420010 });
    if (requestUrl.pathname.endsWith('/memberships')) {
      return jsonResponse({
        groupMemberships: [{
          path: 'groups/420400/memberships/420020',
          user: 'users/420010',
          role: 'groups/420400/roles/1',
        }],
      });
    }
    if (requestUrl.pathname.endsWith(':assignRole')) return jsonResponse({}, 403);
    throw new Error(`Unexpected request: ${requestUrl}`);
  };

  await assert.rejects(
    applyRequestedRobloxGroupRole({
      applicantDiscordId: 'discord-candidate',
      requestedRoleId: '420001',
      sitePool: linkedSitePool(),
      config: config('420400'),
      fetchFn: forbiddenAssignment,
    }),
    (error) => error instanceof RobloxGroupApiError && error.status === 403,
  );
});

test('a Roblox profile ID mismatch stops before checking membership or assigning a role', async () => {
  const visited = [];
  await assert.rejects(
    applyRequestedRobloxGroupRole({
      applicantDiscordId: 'discord-candidate',
      requestedRoleId: '420001',
      sitePool: linkedSitePool(),
      config: config('420500'),
      fetchFn: async (url) => {
        const requestUrl = new URL(String(url));
        visited.push(requestUrl);
        if (requestUrl.pathname.endsWith('/roles')) {
          return jsonResponse({ groupRoles: [{ id: '420001', displayName: 'Pilote' }] });
        }
        if (requestUrl.hostname === 'users.roblox.com') return jsonResponse({ id: 999999 });
        throw new Error('Membership and assignment must not be reached');
      },
    }),
    /could not be verified/,
  );
  assert.equal(visited.length, 2);
});
