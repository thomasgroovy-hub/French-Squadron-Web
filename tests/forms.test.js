import './helpers/env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { sealSession } from '../src/auth/session.js';
import { hasFormsRole, formsAccessMessages } from '../src/auth/guards.js';
import { createApplicationAcceptedEmbed, BOT_ACCENT_COLOR } from '../src/services/embeds.js';
import { grantGuildMemberRole, sendDirectMessage } from '../src/services/discord.js';
import { createApp } from '../src/server.js';
import { webConfig } from '../src/config.js';

const FORMS_ROLE = '1532037579816570981';
const SANCTIONS_ROLE = '1553099793532854382';

const FORMS_MANAGER = {
  id: 'manager-1',
  username: 'Recruteur',
  globalName: 'Chef Recruteur',
  avatarUrl: null,
};

const APPLICANT = {
  id: 'applicant-1',
  username: 'Candidat',
  globalName: 'Pilote Candidat',
  avatarUrl: null,
};

function sessionFor(user) {
  return sealSession({ user }, webConfig.sessionSecret);
}

function cookieFor(user) {
  return `${webConfig.cookieName}=${sessionFor(user)}`;
}

/** Discord stub: member roles plus a DM channel that always succeeds. */
function discordFetch({ roles = [], dmStatus = 200, memberStatus = 204, calls } = {}) {
  return async (url, options = {}) => {
    calls?.push({ url, method: options.method || 'GET' });
    if (url.endsWith('/roles') && options.method === undefined) {
      return { ok: true, status: 200, json: async () => roles.map((id) => ({ id, name: `Role-${id}` })) };
    }
    if (/\/guilds\/[^/]+\/members\/[^/]+$/.test(url)) {
      return { ok: true, status: 200, json: async () => ({ roles }) };
    }
    if (/\/members\/[^/]+\/roles\/[^/]+$/.test(url)) {
      return { ok: memberStatus === 204, status: memberStatus, json: async () => ({}) };
    }
    if (url.endsWith('/users/@me/channels')) {
      return { ok: dmStatus === 200, status: dmStatus, json: async () => ({ id: 'dm-channel-1' }) };
    }
    if (/\/channels\/[^/]+\/messages$/.test(url)) {
      return { ok: true, status: 200, json: async () => ({ id: 'message-1' }) };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };
}

/** Empty-but-valid pool: enough for the table bootstrap and empty listings. */
function emptyPool() {
  return {
    execute: async (query) => {
      if (/^\s*CREATE TABLE/i.test(query)) return [[]];
      return [[]];
    },
  };
}

async function startServer(options) {
  const app = createApp(options);
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  return {
    server,
    port: server.address().port,
    async close() {
      server.close();
    },
  };
}

test('forms role is independent from the sanctions role', () => {
  assert.equal(webConfig.formsRoleId, FORMS_ROLE);
  assert.equal(webConfig.targetRoleId, SANCTIONS_ROLE);

  assert.equal(hasFormsRole({ roles: [FORMS_ROLE] }), true);
  // Holding the supervision/sanctions role grants nothing on the forms side.
  assert.equal(hasFormsRole({ roles: [SANCTIONS_ROLE] }), false);
  assert.equal(hasFormsRole({ roles: [] }), false);
  assert.equal(hasFormsRole(null), false);
  assert.equal(hasFormsRole({ roles: [FORMS_ROLE, SANCTIONS_ROLE] }), true);
});

test('acceptance embed reuses the bot accent colour and required wording', () => {
  const embed = createApplicationAcceptedEmbed({
    formTitle: 'Recrutement pilote',
    applicantName: 'Pilote Candidat',
    grantedRoleName: 'Pilote',
  });
  const json = embed;

  assert.equal(json.title, 'Candidature acceptée');
  assert.equal(json.description, 'Tu as été accepté !');
  assert.equal(json.color, BOT_ACCENT_COLOR);
  assert.equal(BOT_ACCENT_COLOR, 0x475569);
  const fields = Object.fromEntries(json.fields.map((field) => [field.name, field.value]));
  assert.equal(fields.Formulaire, 'Recrutement pilote');
  assert.equal(fields['Rôle attribué'], 'Pilote');
  assert.equal(fields.Candidat, 'Pilote Candidat');
});

test('grantGuildMemberRole PUTs the role on the guild member', async () => {
  const calls = [];
  const result = await grantGuildMemberRole({
    userId: APPLICANT.id,
    roleId: FORMS_ROLE,
    botToken: 'bot-token',
    fetchFn: discordFetch({ calls }),
  });

  assert.equal(result.ok, true);
  const call = calls.find((entry) => entry.method === 'PUT');
  assert.equal(
    call.url,
    `https://discord.com/api/v10/guilds/${webConfig.guildId}/members/${APPLICANT.id}/roles/${FORMS_ROLE}`,
  );
});

test('grantGuildMemberRole reports a Discord refusal instead of throwing', async () => {
  const result = await grantGuildMemberRole({
    userId: APPLICANT.id,
    roleId: FORMS_ROLE,
    botToken: 'bot-token',
    fetchFn: discordFetch({ memberStatus: 403 }),
  });

  assert.equal(result.ok, false);
  assert.equal(result.status, 403);
  assert.match(result.error, /Discord a refusé/);
});

test('sendDirectMessage opens a DM channel and posts the acceptance embed', async () => {
  const calls = [];
  const embed = createApplicationAcceptedEmbed({ formTitle: 'Recrutement pilote' });
  const result = await sendDirectMessage({
    userId: APPLICANT.id,
    embeds: [embed],
    botToken: 'bot-token',
    fetchFn: discordFetch({ calls }),
  });

  assert.equal(result.ok, true);
  assert.equal(result.channelId, 'dm-channel-1');
  assert.ok(calls.some((call) => call.url.endsWith('/users/@me/channels')));
  assert.ok(calls.some((call) => call.url.endsWith('/channels/dm-channel-1/messages')));
});

test('sendDirectMessage surfaces a closed DM without throwing', async () => {
  const result = await sendDirectMessage({
    userId: APPLICANT.id,
    embeds: [createApplicationAcceptedEmbed({ formTitle: 'Recrutement pilote' })],
    botToken: 'bot-token',
    fetchFn: discordFetch({ dmStatus: 403 }),
  });

  assert.equal(result.ok, false);
  assert.match(result.error, /messages directs/);
});

test('Candidatures and Documentation require a session, Réponses requires the forms role', async () => {
  const { server, port, close } = await startServer({ pool: emptyPool(), fetchFn: discordFetch() });

  try {
    // Anonymous visitors are bounced to Discord OAuth2, like the rest of the site.
    for (const path of ['/candidatures', '/documentation', '/reponses']) {
      const res = await fetch(`http://localhost:${port}${path}`, { redirect: 'manual' });
      assert.equal(res.status, 302, `${path} must redirect anonymous visitors`);
      assert.equal(res.headers.get('location'), '/auth/discord');
    }

    // Connected but without the role: Candidatures and Documentation open,
    // Réponses stays closed.
    const asApplicant = { headers: { Cookie: cookieFor(APPLICANT) }, redirect: 'manual' };
    assert.equal((await fetch(`http://localhost:${port}/candidatures`, asApplicant)).status, 200);
    assert.equal((await fetch(`http://localhost:${port}/documentation`, asApplicant)).status, 200);

    const forbidden = await fetch(`http://localhost:${port}/reponses`, asApplicant);
    assert.equal(forbidden.status, 403);
    assert.match(await forbidden.text(), /Accès réservé/);
  } finally {
    await close();
  }
});

test('Réponses tab is exposed to a member holding the forms role', async () => {
  const { server, port, close } = await startServer({
    pool: emptyPool(),
    fetchFn: discordFetch({ roles: [FORMS_ROLE] }),
  });

  try {
    const res = await fetch(`http://localhost:${port}/reponses`, {
      headers: { Cookie: cookieFor(FORMS_MANAGER) },
    });
    const html = await res.text();
    assert.equal(res.status, 200);
    assert.match(html, /Vos candidatures/);
    assert.match(html, /Réponses/);
    // The public Candidatures list must not leak into the Réponses tab.
    assert.doesNotMatch(html, /Formulaires ouverts/);
  } finally {
    await close();
  }
});

test('forms write routes are gated on the server, not only hidden in the markup', async () => {
  const { server, port, close } = await startServer({
    pool: emptyPool(),
    fetchFn: discordFetch({ roles: [] }),
  });

  const writes = [
    ['/candidatures', { title: 'Pirate', question_label: ['x'], question_type: ['short'] }],
    ['/candidatures/1/publier', {}],
    ['/candidatures/1/fermer', {}],
    ['/candidatures/1/supprimer', {}],
    ['/reponses/1/accepter', {}],
    ['/reponses/1/refuser', {}],
    ['/documentation/blocs', { type: 'text', content: 'x' }],
    ['/documentation/blocs/1', { type: 'text', content: 'x' }],
    ['/documentation/blocs/1/deplacer', { direction: 'up' }],
    ['/documentation/blocs/1/supprimer', {}],
  ];

  try {
    for (const [path, body] of writes) {
      const res = await fetch(`http://localhost:${port}${path}`, {
        method: 'POST',
        headers: {
          Cookie: cookieFor(APPLICANT),
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams(body).toString(),
        redirect: 'manual',
      });
      assert.equal(res.status, 403, `${path} must be refused without the forms role`);
      assert.match(await res.text(), new RegExp(formsAccessMessages.denied.slice(0, 30)));
    }
  } finally {
    await close();
  }
});

test('forms write routes refuse anonymous visitors', async () => {
  const { server, port, close } = await startServer({ pool: emptyPool(), fetchFn: discordFetch() });

  try {
    for (const [path, body] of [
      ['/candidatures', { title: 'Pirate' }],
      ['/candidatures/1/publier', {}],
      ['/reponses/1/accepter', {}],
      ['/documentation/blocs', { type: 'text', content: 'x' }],
    ]) {
      const res = await fetch(`http://localhost:${port}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(body).toString(),
        redirect: 'manual',
      });
      assert.equal(res.status, 302, `${path} must require a session`);
      assert.equal(res.headers.get('location'), '/auth/discord');
    }
  } finally {
    await close();
  }
});

test('documentation blocks reject anything but absolute http(s) URLs', async () => {
  const { server, port, close } = await startServer({
    pool: emptyPool(),
    fetchFn: discordFetch({ roles: [FORMS_ROLE] }),
  });

  try {
    for (const url of ['javascript:alert(1)', '/relative/path', 'not-a-url']) {
      const res = await fetch(`http://localhost:${port}/documentation/blocs`, {
        method: 'POST',
        headers: {
          Cookie: cookieFor(FORMS_MANAGER),
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({ block_type: 'link', title: 'Docs', url }).toString(),
        redirect: 'manual',
      });

      assert.equal(res.status, 302, `${url} must be rejected`);
      const location = res.headers.get('location');
      assert.match(location, /^\/documentation\?erreur=/, `${url} must bounce back with an error`);
      assert.doesNotMatch(decodeURIComponent(location), /alert/);
    }
  } finally {
    await close();
  }
});
