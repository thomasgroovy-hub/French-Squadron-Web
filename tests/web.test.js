import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { sealSession, unsealSession } from '../src/auth/session.js';
import {
  fetchGuildMemberRoles,
  formatAccountAge,
  getDiscordCreationDate,
} from '../src/services/discord.js';
import { getLinkedRobloxData } from '../src/services/roblox.js';
import { fetchMemberSanctions } from '../src/services/sanctions.js';
import { createApp } from '../src/server.js';
import { webConfig } from '../src/config.js';

webConfig.discordToken = webConfig.discordToken || 'test-mock-bot-token';

test('session encryption seals and unseals data with tamper protection', () => {
  const secret = 'my-super-secret-test-key-32byteslong';
  const original = { user: { id: '123456789012345678', username: 'TestPilot' } };
  
  const token = sealSession(original, secret);
  assert.ok(token);
  assert.equal(typeof token, 'string');
  assert.equal(token.split('.').length, 3);

  const unsealed = unsealSession(token, secret);
  assert.equal(unsealed.user.id, original.user.id);
  assert.equal(unsealed.user.username, original.user.username);
  assert.ok(unsealed._created);

  // Tampered payload returns null
  assert.equal(unsealSession('invalid.token.data', secret), null);
  assert.equal(unsealSession(token, 'different-secret-key-different-secret'), null);
});

test('getDiscordCreationDate calculates exact date from snowflake', () => {
  // Snowflake ID 175928847299117063 corresponds to 2016-04-30T11:18:25.796Z
  const date = getDiscordCreationDate('175928847299117063');
  assert.ok(date instanceof Date);
  assert.equal(date.getUTCFullYear(), 2016);
  assert.equal(date.getUTCMonth(), 3); // 0-indexed, 3 = April

  const age = formatAccountAge(new Date('2020-01-01T00:00:00Z'), new Date('2024-03-01T00:00:00Z'));
  assert.equal(age, '4 ans, 2 mois');
});

test('fetchGuildMemberRoles calls Discord API with Bot token and detects role 1553099793532854382', async () => {
  let capturedUrl = '';
  let capturedHeaders = {};

  const fakeFetch = async (url, options) => {
    capturedUrl = url;
    capturedHeaders = options.headers;
    return {
      ok: true,
      status: 200,
      json: async () => ({
        user: { id: '9876543210' },
        nick: 'Commandant',
        roles: ['1487266203864006707', '1553099793532854382'],
      }),
    };
  };

  const result = await fetchGuildMemberRoles({
    userId: '9876543210',
    guildId: '1487258655840669807',
    botToken: 'bot-token-xyz',
    fetchFn: fakeFetch,
  });

  assert.equal(capturedUrl, 'https://discord.com/api/v10/guilds/1487258655840669807/members/9876543210');
  assert.equal(capturedHeaders.Authorization, 'Bot bot-token-xyz');
  assert.equal(result.inGuild, true);
  assert.equal(result.nickname, 'Commandant');
  assert.equal(result.hasTargetRole, true);
});

test('fetchGuildMemberRoles returns false when user lacks role 1553099793532854382 or is not in guild', async () => {
  const fakeFetch404 = async () => ({
    ok: false,
    status: 404,
  });

  const notFound = await fetchGuildMemberRoles({
    userId: '99999',
    guildId: '1487258655840669807',
    botToken: 'token',
    fetchFn: fakeFetch404,
  });
  assert.equal(notFound.inGuild, false);
  assert.equal(notFound.hasTargetRole, false);

  const fakeFetchOtherRoles = async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      roles: ['111111111111111111'],
    }),
  });

  const withoutTargetRole = await fetchGuildMemberRoles({
    userId: '11111',
    guildId: '1487258655840669807',
    botToken: 'token',
    fetchFn: fakeFetchOtherRoles,
  });
  assert.equal(withoutTargetRole.inGuild, true);
  assert.equal(withoutTargetRole.hasTargetRole, false);
});

test('getLinkedRobloxData queries MySQL and Roblox API', async () => {
  const mockPool = {
    execute: async (query, params) => {
      assert.match(query, /roblox_discord_links/);
      assert.deepEqual(params, ['discord-user-123']);
      return [[{
        discord_user_id: 'discord-user-123',
        roblox_user_id: '54321',
        roblox_username: 'PilotRoblox',
        verification_rank: '42',
      }]];
    },
  };

  const fakeFetch = async (url) => {
    if (url.includes('users.roblox.com')) {
      return {
        ok: true,
        json: async () => ({
          id: 54321,
          name: 'PilotRoblox',
          displayName: 'AcePilot',
          created: '2019-05-10T12:00:00Z',
        }),
      };
    }
    if (url.includes('thumbnails.roblox.com')) {
      return {
        ok: true,
        json: async () => ({
          data: [{ imageUrl: 'https://images.roblox.com/avatar123.png' }],
        }),
      };
    }
    throw new Error('Unknown URL');
  };

  const res = await getLinkedRobloxData('discord-user-123', {
    pool: mockPool,
    fetchFn: fakeFetch,
  });

  assert.equal(res.isLinked, true);
  assert.equal(res.data.username, 'PilotRoblox');
  assert.equal(res.data.displayName, 'AcePilot');
  assert.equal(res.data.userId, '54321');
  assert.equal(res.data.avatarUrl, 'https://images.roblox.com/avatar123.png');
  assert.equal(res.data.rank, '42');
});

test('fetchMemberSanctions queries strikes and cases tables', async () => {
  const mockPool = {
    execute: async (query, params) => {
      assert.deepEqual(params, ['discord-user-456']);
      if (query.includes('FROM strikes')) {
        return [[
          {
            id: 1,
            moderator_discord_id: 'mod-1',
            raison: 'Spam vocal',
            created_at: new Date('2024-02-15T10:00:00Z'),
          },
        ]];
      }
      if (query.includes('FROM moderation_cases')) {
        return [[
          {
            id: 2,
            type: 'exclusion',
            moderator_discord_id: 'mod-2',
            raison: 'Comportement',
            created_at: new Date('2024-02-16T12:00:00Z'),
          },
        ]];
      }
      return [[]];
    },
  };

  const result = await fetchMemberSanctions('discord-user-456', mockPool);
  assert.equal(result.strikes.length, 1);
  assert.equal(result.strikes[0].id, 1);
  assert.equal(result.strikes[0].reason, 'Spam vocal');
  assert.equal(result.cases.length, 1);
  assert.equal(result.cases[0].type, 'exclusion');
  assert.equal(result.totalCount, 2);
});

test('web server renders home page with Discord login link', async () => {
  const app = createApp({ pool: null });
  const server = http.createServer(app);

  await new Promise((resolve) => server.listen(0, resolve));
  const port = server.address().port;

  try {
    const res = await fetch(`http://localhost:${port}/`);
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.match(html, /French Squadron Utilities/);
    assert.match(html, /Se connecter avec Discord/);
    assert.match(html, /\/auth\/discord/);
  } finally {
    server.close();
  }
});

test('web server /auth/discord sets state cookie and redirects to Discord OAuth2', async () => {
  const app = createApp({
    pool: null,
    config: {
      clientId: 'mock-client-id-123',
      clientSecret: 'mock-client-secret-abc',
      redirectUri: 'http://localhost:3000/auth/discord/callback',
      isProduction: false,
    },
  });
  const server = http.createServer(app);

  await new Promise((resolve) => server.listen(0, resolve));
  const port = server.address().port;

  try {
    const res = await fetch(`http://localhost:${port}/auth/discord`, {
      redirect: 'manual',
    });
    assert.equal(res.status, 302);
    const location = res.headers.get('location');
    assert.match(location, /https:\/\/discord\.com\/oauth2\/authorize/);
    assert.match(location, /scope=identify/);
    assert.match(location, /client_id=mock-client-id-123/);

    const cookieHeader = res.headers.get('set-cookie');
    assert.match(cookieHeader, /oauth_state=/);
  } finally {
    server.close();
  }
});

test('web server /auth/discord/callback handles successful token exchange and creates session', async () => {
  const fakeFetch = async (url) => {
    if (url.includes('/oauth2/token')) {
      return {
        ok: true,
        json: async () => ({
          access_token: 'fake-access-token-123',
          token_type: 'Bearer',
        }),
      };
    }
    if (url.includes('/users/@me')) {
      return {
        ok: true,
        json: async () => ({
          id: '123456789',
          username: 'TestDiscordUser',
          global_name: 'Test Display Name',
          avatar: 'abcdef123456',
        }),
      };
    }
    return { ok: false, status: 404 };
  };

  const app = createApp({
    pool: null,
    fetchFn: fakeFetch,
    config: {
      clientId: 'mock-client-id-123',
      clientSecret: 'mock-client-secret-abc',
      redirectUri: 'http://localhost:3000/auth/discord/callback',
      isProduction: false,
      cookieName: 'fpcs_session',
      sessionSecret: 'test-session-secret',
    },
  });
  const server = http.createServer(app);

  await new Promise((resolve) => server.listen(0, resolve));
  const port = server.address().port;

  try {
    const res = await fetch(`http://localhost:${port}/auth/discord/callback?code=good-code&state=correct-state`, {
      redirect: 'manual',
      headers: {
        Cookie: 'oauth_state=correct-state',
      },
    });

    assert.equal(res.status, 302);
    assert.equal(res.headers.get('location'), '/profile');
    const setCookie = res.headers.get('set-cookie');
    assert.match(setCookie, /fpcs_session=/);
  } finally {
    server.close();
  }
});

test('web server /auth/logout clears session and redirects to /', async () => {
  const app = createApp({ pool: null });
  const server = http.createServer(app);

  await new Promise((resolve) => server.listen(0, resolve));
  const port = server.address().port;

  try {
    const res = await fetch(`http://localhost:${port}/auth/logout`, {
      redirect: 'manual',
    });
    assert.equal(res.status, 302);
    assert.equal(res.headers.get('location'), '/');
  } finally {
    server.close();
  }
});

test('web server /profile redirects unauthenticated users to /auth/discord', async () => {
  const app = createApp({ pool: null });
  const server = http.createServer(app);

  await new Promise((resolve) => server.listen(0, resolve));
  const port = server.address().port;

  try {
    const res = await fetch(`http://localhost:${port}/profile`, {
      redirect: 'manual',
    });
    assert.equal(res.status, 302);
    assert.equal(res.headers.get('location'), '/auth/discord');
  } finally {
    server.close();
  }
});

test('web server /profile renders profile with sanctions when role 1553099793532854382 is present', async () => {
  const userId = '1454217001626243288';
  const sessionToken = sealSession({
    user: {
      id: userId,
      username: 'SquadronCommander',
      globalName: 'Squadron Commander',
      avatarUrl: 'https://cdn.discordapp.com/avatars/1454217001626243288/abc.png',
    },
  }, webConfig.sessionSecret);

  const mockPool = {
    execute: async (query) => {
      if (query.includes('roblox_discord_links')) {
        return [[{
          discord_user_id: userId,
          roblox_user_id: '998877',
          roblox_username: 'RobloxCaptain',
          verification_rank: '10',
        }]];
      }
      if (query.includes('FROM strikes')) {
        return [[{
          id: 101,
          moderator_discord_id: 'mod-99',
          raison: 'Absence en vol sans préavis',
          created_at: new Date('2024-03-01T15:00:00Z'),
        }]];
      }
      return [[]];
    },
  };

  const fakeFetch = async (url) => {
    if (url.includes('discord.com/api/v10/guilds')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          nick: 'Squadron Lead',
          roles: ['1553099793532854382'], // Target role present!
        }),
      };
    }
    if (url.includes('users.roblox.com')) {
      return {
        ok: true,
        json: async () => ({
          id: 998877,
          name: 'RobloxCaptain',
          created: '2021-01-01T00:00:00Z',
        }),
      };
    }
    if (url.includes('thumbnails.roblox.com')) {
      return {
        ok: true,
        json: async () => ({
          data: [{ imageUrl: 'https://images.roblox.com/headshot.png' }],
        }),
      };
    }
    return { ok: false, status: 404 };
  };

  const app = createApp({ pool: mockPool, fetchFn: fakeFetch });
  const server = http.createServer(app);

  await new Promise((resolve) => server.listen(0, resolve));
  const port = server.address().port;

  try {
    const res = await fetch(`http://localhost:${port}/profile`, {
      headers: {
        Cookie: `${webConfig.cookieName}=${sessionToken}`,
      },
    });

    assert.equal(res.status, 200);
    const html = await res.text();

    // Verifies Discord identity
    assert.match(html, /Squadron Commander/);
    assert.match(html, /@SquadronCommander/);

    // Verifies Roblox identity
    assert.match(html, /RobloxCaptain/);
    assert.match(html, /#10/);

    // Verifies role presence and sanctions display
    assert.match(html, /Fiche Publique Active \(Rôle 1553099793532854382\)/);
    assert.match(html, /Fiche Personnelle Publique/);
    assert.match(html, /Absence en vol sans préavis/);
    assert.match(html, /Avertissement n°101/);
  } finally {
    server.close();
  }
});

test('web server /profile displays restricted message when target role is missing', async () => {
  const userId = '1454217001626243288';
  const sessionToken = sealSession({
    user: {
      id: userId,
      username: 'RegularUser',
      globalName: 'Regular User',
      avatarUrl: 'https://cdn.discordapp.com/avatars/1454217001626243288/abc.png',
    },
  }, webConfig.sessionSecret);

  const fakeFetch = async (url) => {
    if (url.includes('discord.com/api/v10/guilds')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          roles: ['999999999999999999'], // Does NOT have 1553099793532854382
        }),
      };
    }
    return { ok: false, status: 404 };
  };

  const app = createApp({ pool: null, fetchFn: fakeFetch });
  const server = http.createServer(app);

  await new Promise((resolve) => server.listen(0, resolve));
  const port = server.address().port;

  try {
    const res = await fetch(`http://localhost:${port}/profile`, {
      headers: {
        Cookie: `${webConfig.cookieName}=${sessionToken}`,
      },
    });

    assert.equal(res.status, 200);
    const html = await res.text();

    assert.match(html, /Fiche Personnelle Restreinte/);
    assert.match(html, /Rôle 1553099793532854382 non détecté/);
    assert.doesNotMatch(html, /Fiche Publique Active/);
  } finally {
    server.close();
  }
});
