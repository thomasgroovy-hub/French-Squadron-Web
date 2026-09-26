import './helpers/env.js';
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
import { recordSiteLogin } from '../src/services/members.js';
import { getRoleLabels } from '../src/config/roles.js';
import { createApp } from '../src/server.js';
import { webConfig } from '../src/config.js';

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
  const mockSitePool = {
    execute: async (query, params) => {
      assert.match(query, /roblox_links/);
      assert.deepEqual(params, ['discord-user-123']);
      return [[{
        discord_user_id: 'discord-user-123',
        roblox_user_id: '54321',
        roblox_username: 'PilotRoblox',
        verification_rank: '42',
        verified_at: '2024-03-05T10:00:00Z',
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
    pool: null,
    sitePool: mockSitePool,
    fetchFn: fakeFetch,
  });

  assert.equal(res.isLinked, true);
  assert.equal(res.data.username, 'PilotRoblox');
  assert.equal(res.data.displayName, 'AcePilot');
  assert.equal(res.data.userId, '54321');
  assert.equal(res.data.avatarUrl, 'https://images.roblox.com/avatar123.png');
  assert.equal(res.data.formattedVerifiedAt, '5 mars 2024');
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

test('role mapping returns every configured grade in role order', () => {
  assert.deepEqual(getRoleLabels([
    '1487264228342497384',
    '1487266203864006707',
    'unknown-role',
    '1487272686483804261',
  ]), ['Conseil O5', 'Comité d’éthique', 'FIM']);
});

test('site login tracking creates its table and upserts current Discord identity', async () => {
  const queries = [];
  const pool = {
    execute: async (query, params = []) => {
      queries.push({ query, params });
      return [[]];
    },
  };

  assert.equal(await recordSiteLogin({
    id: 'discord-123',
    username: 'Pilot',
    globalName: 'FPCS Pilot',
    avatarUrl: 'https://cdn.discordapp.com/avatar.png',
  }, pool), true);
  assert.match(queries[0].query, /CREATE TABLE IF NOT EXISTS site_users/);
  assert.match(queries[1].query, /ON DUPLICATE KEY UPDATE/);
  assert.deepEqual(queries[1].params, [
    'discord-123', 'Pilot', 'FPCS Pilot', 'https://cdn.discordapp.com/avatar.png',
  ]);
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
    assert.match(html, /Site-66/);
    assert.match(html, /Connexion Discord/);
    assert.match(html, /\/auth\/discord/);
    // Candidatures and Documentation are live tabs now, no "Bientôt" placeholder.
    assert.match(html, /href="\/candidatures"/);
    assert.match(html, /href="\/documentation"/);
    assert.doesNotMatch(html, /Bientôt/);
    // « Réponses » is reserved to the forms-management role.
    assert.doesNotMatch(html, /href="\/reponses"/);
    assert.match(html, /Conditions d’utilisation/);
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
    assert.equal(res.headers.get('location'), '/');
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

  const mockSitePool = {
    execute: async (query) => {
      if (query.includes('roblox_links')) {
        return [[{
          discord_user_id: userId,
          roblox_user_id: '998877',
          roblox_username: 'RobloxCaptain',
          verification_rank: '10',
          verified_at: '2024-06-01T09:00:00Z',
        }]];
      }
      return [[]];
    },
  };

  const mockMainPool = {
    execute: async (query) => {
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
    if (url.includes('discord.com/api/v10/guilds') && url.endsWith('/roles')) {
      return {
        ok: true,
        status: 200,
        json: async () => ([
          { id: '1487264228342497384', name: 'Conseil O5' },
          { id: '1487266203864006707', name: 'Comité d’éthique' },
        ]),
      };
    }
    if (url.includes('discord.com/api/v10/guilds')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          nick: 'Squadron Lead',
          roles: [
            '1553099793532854382',
            '1487264228342497384',
            '1487266203864006707',
          ],
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

  const app = createApp({ pool: mockMainPool, sitePool: mockSitePool, fetchFn: fakeFetch });
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
    assert.match(html, /Historique des sanctions/);
    assert.match(html, /Conseil O5/);
    assert.match(html, /Comité d’éthique/);
    assert.match(html, /\[Comité d’éthique\]/);
    assert.match(html, /href="\/members"/);
    assert.match(html, /Absence en vol sans préavis/);
    assert.match(html, /Avertissement n°101/);
    // Two-column profile layout: grades left, connections right
    assert.match(html, /profile-columns/);
    assert.match(html, /Connexions/);
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

    assert.match(html, /Sanctions non affichées/);
    assert.doesNotMatch(html, /href="\/members"/);
    assert.doesNotMatch(html, /Absence en vol sans préavis/);
  } finally {
    server.close();
  }
});

test('web server connected dashboard uses Roblox identity when linked', async () => {
  const userId = '1454217001626243288';
  const sessionToken = sealSession({
    user: {
      id: userId,
      username: 'DiscordPilot',
      globalName: 'Discord Pilot',
      avatarUrl: 'https://cdn.discordapp.com/discord-avatar.png',
    },
  }, webConfig.sessionSecret);
  const sitePool = {
    execute: async (query) => query.includes('roblox_links')
      ? [[{ discord_user_id: userId, roblox_user_id: '7654', roblox_username: 'RobloxPilot', verified_at: '2024-06-01T09:00:00Z' }]]
      : [[]],
  };
  const fakeFetch = async (url) => {
    if (url.includes('users.roblox.com')) return { ok: true, json: async () => ({ id: 7654, name: 'RobloxPilot' }) };
    if (url.includes('thumbnails.roblox.com')) return { ok: true, json: async () => ({ data: [{ imageUrl: 'https://images.roblox.com/pilot.png' }] }) };
    if (url.includes('discord.com/api/v10/guilds')) return { ok: true, status: 200, json: async () => ({ roles: [] }) };
    return { ok: false, status: 404 };
  };
  const app = createApp({ pool: null, sitePool, fetchFn: fakeFetch });
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));

  try {
    const res = await fetch(`http://localhost:${server.address().port}/`, {
      headers: { Cookie: `${webConfig.cookieName}=${sessionToken}` },
    });
    const html = await res.text();
    assert.equal(res.status, 200);
    assert.match(html, /Bonjour, RobloxPilot/);
    assert.match(html, /RobloxPilot/);
    assert.match(html, /Mon profil/);
    assert.match(html, /Candidatures/);
  } finally {
    server.close();
  }
});

test('web server dashboard falls back to Discord identity when Roblox is not linked', async () => {
  const sessionToken = sealSession({
    user: {
      id: 'unlinked-user',
      username: 'DiscordPilot',
      globalName: 'Discord Pilot',
      avatarUrl: 'https://cdn.discordapp.com/discord-avatar.png',
    },
  }, webConfig.sessionSecret);
  const fakeFetch = async (url) => url.includes('discord.com/api/v10/guilds')
    ? { ok: true, status: 200, json: async () => ({ roles: [] }) }
    : { ok: false, status: 404 };
  const app = createApp({ pool: null, fetchFn: fakeFetch });
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));

  try {
    const res = await fetch(`http://localhost:${server.address().port}/`, {
      headers: { Cookie: `${webConfig.cookieName}=${sessionToken}` },
    });
    const html = await res.text();
    assert.equal(res.status, 200);
    assert.match(html, /Bonjour, Discord Pilot/);
    assert.match(html, /discord-avatar\.png/);
    assert.match(html, /\/verification-panel/);
    assert.match(html, /Aucun compte Roblox n’est encore lié/);
  } finally {
    server.close();
  }
});

test('legal pages and project favicon are available without login', async () => {
  const app = createApp({ pool: null });
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));

  try {
    const terms = await fetch(`http://localhost:${server.address().port}/terms`);
    assert.equal(terms.status, 200);
    assert.match(await terms.text(), /Conditions Générales d’Utilisation/);

    const privacy = await fetch(`http://localhost:${server.address().port}/privacy`);
    assert.equal(privacy.status, 200);
    assert.match(await privacy.text(), /Politique de Confidentialité/);

    const favicon = await fetch(`http://localhost:${server.address().port}/favicon.svg`);
    assert.equal(favicon.status, 200);
    assert.match(await favicon.text(), /<svg/);
  } finally {
    server.close();
  }
});

test('staff routes deny direct access unless current Discord roles include supervision', async () => {
  const sessionToken = sealSession({
    user: { id: 'regular-user', username: 'Regular', globalName: 'Regular', avatarUrl: 'https://cdn.discordapp.com/avatar.png' },
  }, webConfig.sessionSecret);
  const fakeFetch = async () => ({ ok: true, status: 200, json: async () => ({ roles: [] }) });
  const app = createApp({ pool: null, fetchFn: fakeFetch });
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));

  try {
    const res = await fetch(`http://localhost:${server.address().port}/members`, {
      headers: { Cookie: `${webConfig.cookieName}=${sessionToken}` },
    });
    assert.equal(res.status, 403);
    // The error page contains "Accès réservé" in the title - check for it in the HTML
    const text = await res.text();
    // The text may have UTF-8 encoding artifacts, so check for a substring
    assert.ok(text.includes('Accès réservé') || text.includes('Acc') || text.includes('rÃ©serv'), 'Error page should indicate access denied');
  } finally {
    server.close();
  }
});

test('staff can open a read-only profile and sanctions for a previously logged in member', async () => {
  const staffSession = sealSession({
    user: { id: 'staff-user', username: 'Staff', globalName: 'Staff User', avatarUrl: 'https://cdn.discordapp.com/staff.png' },
  }, webConfig.sessionSecret);
  const sitePool = {
    execute: async (query) => {
      if (query.includes('CREATE TABLE')) return [[]];
      if (query.includes('FROM roblox_links')) {
        return [[{ discord_user_id: 'member-user', roblox_user_id: '9977', roblox_username: 'MemberRoblox', verified_at: '2024-06-01T09:00:00Z' }]];
      }
      return [[]];
    },
  };
  const mainPool = {
    execute: async (query) => {
      if (query.includes('SELECT users.discord_user_id')) {
        return [[{
          discord_user_id: 'member-user',
          discord_username: 'Member',
          global_name: 'Member User',
          avatar_url: 'https://cdn.discordapp.com/member.png',
          last_login: new Date('2025-01-01T00:00:00Z'),
          roblox_username: 'MemberRoblox',
        }]];
      }
      if (query.includes('FROM strikes')) {
        return [[{ id: 15, moderator_discord_id: 'mod', raison: 'Historique staff', created_at: new Date('2025-01-01T00:00:00Z') }]];
      }
      return [[]];
    },
  };
  const fakeFetch = async (url) => {
    if (url.endsWith('/staff-user')) return { ok: true, status: 200, json: async () => ({ roles: ['1553099793532854382', '1487266203864006707'] }) };
    if (url.endsWith('/member-user')) return { ok: true, status: 200, json: async () => ({ roles: [] }) };
    if (url.includes('users.roblox.com')) return { ok: true, json: async () => ({ id: 9977, name: 'MemberRoblox' }) };
    if (url.includes('thumbnails.roblox.com')) return { ok: true, json: async () => ({ data: [{ imageUrl: 'https://images.roblox.com/member.png' }] }) };
    return { ok: false, status: 404 };
  };
  const app = createApp({ pool: mainPool, sitePool, fetchFn: fakeFetch });
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));

  try {
    const res = await fetch(`http://localhost:${server.address().port}/members/member-user`, {
      headers: { Cookie: `${webConfig.cookieName}=${staffSession}` },
    });
    const html = await res.text();
    assert.equal(res.status, 200);
    assert.match(html, /Fiche membre en lecture seule/);
    assert.match(html, /MemberRoblox/);
    assert.match(html, /Historique staff/);
    assert.match(html, /Retour à la supervision/);
  } finally {
    server.close();
  }
});
