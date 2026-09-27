import './helpers/env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { sealSession } from '../src/auth/session.js';
import { hasFormsRole, formsAccessMessages } from '../src/auth/guards.js';
import { createApplicationAcceptedPayload, BOT_ACCENT_COLOR } from '../src/services/embeds.js';
import { FORBIDDEN_GRANTABLE_ROLE_IDS, grantGuildMemberRole, invalidateGuildRoleCache, sendDirectMessage } from '../src/services/discord.js';
import { MessageFlags } from 'discord.js';
import { createApp } from '../src/server.js';
import { webConfig } from '../src/config.js';
import { googleFormHtml, googlePageFetch } from './helpers/google-form.js';

const FORMS_ROLE = '1532037579816570981';
const SANCTIONS_ROLE = '1553099793532854382';
const PILOT_ROLE = '1400000000000000001';

/** Rôles qu'un formulaire ne doit jamais pouvoir accorder. */
const FORBIDDEN_ROLE_A = '1487264228342497384';
const FORBIDDEN_ROLE_B = '1487276505712033883';

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
function discordFetch({ roles = [], dmStatus = 200, memberStatus = 204, calls, bodies, rolesStatus = 200 } = {}) {  return async (url, options = {}) => {
    calls?.push({ url, method: options.method || 'GET' });
    if (options.body) bodies?.push({ url, body: options.body });
    if (url.endsWith('/roles') && options.method === undefined) {
      if (rolesStatus !== 200) {
        return { ok: false, status: rolesStatus, json: async () => ({}) };
      }
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

/**
 * Étend `discordFetch` avec la lecture de la page publique d'un Google Form.
 * `memberRoles` permet de simuler un membre sans le rôle Candidatures.
 */
function googleImportFetch({ html = googleFormHtml(), memberRoles = [FORMS_ROLE], urls = [] } = {}) {
  const discord = discordFetch();
  const google = googlePageFetch(html);
  return async (url, options) => {
    const target = String(url);
    urls.push(target);
    if (target.includes('docs.google.com') || target.includes('forms.gle')) return google(url, options);
    if (/\/guilds\/[^/]+\/members\/[^/]+$/.test(target)) {
      return { ok: true, status: 200, json: async () => ({ roles: memberRoles }) };
    }
    return discord(url, options);
  };
}

/** POST du builder vers `/candidatures`, avec la session du créateur. */
function postBuilder(port, fields) {
  return fetch(`http://localhost:${port}/candidatures`, {
    method: 'POST',
    headers: {
      Cookie: cookieFor(FORMS_MANAGER),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams(fields).toString(),
    redirect: 'manual',
  });
}

/** `redirect: 'manual'` : un garde de redirection ne doit jamais sortir sur Internet. */
function postGoogleImport(port, fields, user = FORMS_MANAGER) {
  return fetch(`http://localhost:${port}/candidatures/importer-google-form`, {
    method: 'POST',
    headers: {
      Cookie: cookieFor(user),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams(fields).toString(),
    redirect: 'manual',
  });
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

test('the acceptance DM is a Components V2 message carrying the bot accent colour', () => {
  const payload = createApplicationAcceptedPayload({
    formTitle: 'Recrutement pilote',
    applicantName: 'Pilote Candidat',
    grantedRoleName: 'Pilote',
  });

  // Un embed classique ne donnerait pas exactement le même rendu que les
  // messages du bot : le message doit passer par un conteneur V2 accentué.
  assert.equal(payload.flags, MessageFlags.IsComponentsV2);
  assert.equal(payload.embeds, undefined, 'aucun embed classique ne doit être envoyé');
  assert.equal(Array.isArray(payload.components), true);

  const [container] = payload.components.map((component) => (
    typeof component?.toJSON === 'function' ? component.toJSON() : component
  ));
  assert.equal(container.accent_color, BOT_ACCENT_COLOR);
  assert.equal(BOT_ACCENT_COLOR, 0x475569);

  const texts = container.components.map((component) => component.content);
  assert.match(texts[0], /Candidature acceptée/);
  assert.ok(texts.includes('Tu as été accepté !'));
  assert.ok(texts.includes('**Formulaire**\nRecrutement pilote'));
  assert.ok(texts.includes('**Rôle attribué**\nPilote'));
  assert.ok(texts.includes('**Candidat**\nPilote Candidat'));
  assert.ok(texts.includes('*FPCS Utilities*'));
});

test('the acceptance DM omits a section it has no data for', () => {
  const payload = createApplicationAcceptedPayload({ formTitle: 'Recrutement pilote' });
  const [container] = payload.components.map((component) => (
    typeof component?.toJSON === 'function' ? component.toJSON() : component
  ));
  const texts = container.components.map((component) => component.content).join('\n');

  assert.doesNotMatch(texts, /Rôle attribué/);
  // `Candidature acceptée` contient déjà « Candidat » : on cible la section.
  assert.doesNotMatch(texts, /\*\*Candidat\*\*/);
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

test('sendDirectMessage opens a DM channel and posts the payload untouched', async () => {
  const calls = [];
  const bodies = [];
  const payload = createApplicationAcceptedPayload({ formTitle: 'Recrutement pilote' });
  const result = await sendDirectMessage({
    userId: APPLICANT.id,
    payload,
    botToken: 'bot-token',
    fetchFn: discordFetch({ calls, bodies }),
  });

  assert.equal(result.ok, true);
  assert.equal(result.channelId, 'dm-channel-1');
  assert.ok(calls.some((call) => call.url.endsWith('/users/@me/channels')));
  assert.ok(calls.some((call) => call.url.endsWith('/channels/dm-channel-1/messages')));

  // The payload reaches Discord as-is, so `components` and `flags` survive.
  const messageBody = JSON.parse(bodies.at(-1).body);
  assert.equal(messageBody.flags, MessageFlags.IsComponentsV2);
  assert.equal(messageBody.embeds, undefined);
  assert.equal(Array.isArray(messageBody.components), true);
});

test('sendDirectMessage refuses to post without a payload', async () => {
  const result = await sendDirectMessage({
    userId: APPLICANT.id,
    botToken: 'bot-token',
    fetchFn: discordFetch(),
  });

  assert.equal(result.ok, false);
  assert.equal(result.status, 400);
});

test('sendDirectMessage surfaces a closed DM without throwing', async () => {
  const result = await sendDirectMessage({
    userId: APPLICANT.id,
    payload: createApplicationAcceptedPayload({ formTitle: 'Recrutement pilote' }),
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

test('the forbidden grantable roles never appear in the builder select', async () => {
  const { server, port, close } = await startServer({
    pool: emptyPool(),
    // The two forbidden roles are returned by Discord, as they would be in
    // production: the filtering must happen server-side.
    fetchFn: discordFetch({
      roles: [FORMS_ROLE, PILOT_ROLE, FORBIDDEN_ROLE_A, FORBIDDEN_ROLE_B],
    }),
  });

  try {
    const res = await fetch(`http://localhost:${port}/candidatures/nouveau`, {
      headers: { Cookie: cookieFor(FORMS_MANAGER) },
    });
    const html = await res.text();

    assert.equal(res.status, 200);
    assert.match(html, /<select[^>]*name="granted_role_id"/, 'le rôle se choisit dans une liste');
    assert.doesNotMatch(html, /name="granted_role_id"[^>]*type="text"/, 'plus de saisie libre à la main');

    const select = html.slice(html.indexOf('name="granted_role_id"'));
    const selected = select.slice(0, select.indexOf('</select>'));

    assert.doesNotMatch(selected, new RegExp(FORBIDDEN_ROLE_A));
    assert.doesNotMatch(selected, new RegExp(FORBIDDEN_ROLE_B));
    assert.ok(selected.includes('Aucun rôle'), '« Aucun rôle » reste le choix par défaut');
    assert.ok(selected.includes('Role-1400000000000000001'), 'un rôle autorisé est bien proposé');
    assert.ok(selected.includes(`Role-${FORMS_ROLE}`));
  } finally {
    await close();
  }
});

test('a forbidden role posted by hand is refused, not silently stored', async () => {
  const { server, port, close } = await startServer({
    pool: emptyPool(),
    fetchFn: discordFetch({ roles: [FORMS_ROLE, FORBIDDEN_ROLE_A, FORBIDDEN_ROLE_B] }),
  });

  try {
    for (const forbiddenId of [FORBIDDEN_ROLE_A, FORBIDDEN_ROLE_B]) {
      const res = await fetch(`http://localhost:${port}/candidatures`, {
        method: 'POST',
        headers: {
          Cookie: cookieFor(FORMS_MANAGER),
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({
          title: 'Recrutement',
          granted_role_id: forbiddenId,
          'question_label[]': 'Motivation',
          'question_type[]': 'short',
        }).toString(),
        redirect: 'manual',
      });

      // 400 = re-rendered with an error, 302 = saved. A forbidden id must never
      // reach the database, so the save must be refused.
      assert.equal(res.status, 400, `le rôle ${forbiddenId} ne doit pas être enregistré`);
      const html = await res.text();
      assert.doesNotMatch(html, new RegExp(`value="${forbiddenId}"`));
    }
  } finally {
    await close();
  }
});

test('an allowed role is still saved through the select', async () => {
  const written = [];
  const pool = {
    execute: async (query, params = []) => {
      const sql = query.replace(/\s+/g, ' ').trim();
      if (/^CREATE TABLE/i.test(sql)) return [[]];
      if (/^SHOW COLUMNS/i.test(sql)) return [[{ Field: 'options' }]];
      if (/^INSERT INTO forms /i.test(sql)) {
        written.push(params[3]);
        return [{ insertId: 7, affectedRows: 1 }];
      }
      // `createForm` relit la ligne qu'il vient d'écrire pour rediriger dessus.
      if (/FROM forms/i.test(sql) && /WHERE forms\.id/i.test(sql)) {
        return [[{
          id: 7,
          creator_discord_id: FORMS_MANAGER.id,
          title: params[1] || 'Recrutement',
          description: '',
          granted_role_id: PILOT_ROLE,
          status: 'draft',
        }]];
      }
      return [[]];
    },
    getConnection() {
      return {
        execute: this.execute,
        beginTransaction: async () => {},
        commit: async () => {},
        rollback: async () => {},
        release: () => {},
      };
    },
  };

  const { server, port, close } = await startServer({
    pool,
    fetchFn: discordFetch({ roles: [FORMS_ROLE, PILOT_ROLE] }),
  });

  try {
    const res = await fetch(`http://localhost:${port}/candidatures`, {
      method: 'POST',
      headers: {
        Cookie: cookieFor(FORMS_MANAGER),
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        title: 'Recrutement',
        granted_role_id: PILOT_ROLE,
        'question_label[]': 'Motivation',
        'question_type[]': 'short',
      }).toString(),
      redirect: 'manual',
    });

    assert.equal(res.status, 302, 'un rôle autorisé passe par le flux de création habituel');
    assert.equal(res.headers.get('location'), '/candidatures/7');
    assert.deepEqual(written, [PILOT_ROLE]);
  } finally {
    await close();
  }
});

test('the builder stays usable when the guild roles cannot be loaded', async () => {
  // Un test précédent a réussi à charger les rôles : sans invalider le cache,
  // celui-ci servirait la liste mémorisée et l'échec ne serait jamais vu.
  invalidateGuildRoleCache();
  const { server, port, close } = await startServer({
    pool: emptyPool(),
    fetchFn: discordFetch({ rolesStatus: 500 }),
  });

  try {
    const res = await fetch(`http://localhost:${port}/candidatures/nouveau`, {
      headers: { Cookie: cookieFor(FORMS_MANAGER) },
    });
    const html = await res.text();

    assert.equal(res.status, 200, 'un échec Discord ne doit pas casser la page');
    assert.match(html, /Impossible de charger la liste des r[ôo]les du serveur/);
    assert.match(html, /<option value="">Aucun rôle<\/option>/);

    const select = html.slice(html.indexOf('name="granted_role_id"'));
    const options = select.slice(0, select.indexOf('</select>')).match(/<option/g) || [];
    assert.equal(options.length, 1, 'seul « Aucun rôle » est proposé');
  } finally {
    await close();
  }
});

test('FORBIDDEN_GRANTABLE_ROLE_IDS lists exactly the two protected roles', () => {
  assert.deepEqual([...FORBIDDEN_GRANTABLE_ROLE_IDS].sort(), [FORBIDDEN_ROLE_A, FORBIDDEN_ROLE_B].sort());
});

test('the Google import pre-fills the builder without writing anything', async () => {
  const writes = [];
  const urls = [];
  const pool = {
    execute: async (query) => {
      const sql = query.replace(/\s+/g, ' ').trim();
      if (/^(INSERT|UPDATE|DELETE)/i.test(sql)) writes.push(sql);
      if (/^CREATE TABLE/i.test(sql)) return [[]];
      return [[]];
    },
  };
  const { server, port, close } = await startServer({
    pool,
    fetchFn: googleImportFetch({ urls }),
  });

  try {
    const res = await postGoogleImport(port, { url: 'https://forms.gle/abc123' });
    const html = await res.text();

    assert.equal(res.status, 200);
    assert.match(html, /Recrutement Pilote/);
    assert.match(html, /Quel est votre pseudo \?/);
    // L'avertissement « pas de synchronisation » doit être visible à l'écran.
    assert.match(html, /Import ponctuel/);
    // Aucune écriture : le créateur relit et valide lui-même avant d'enregistrer.
    assert.deepEqual(writes, []);
    // Le seul aller-retour externe est la lecture de la page publique.
    assert.ok(urls.every((url) => url.includes('forms.gle') || url.includes('discord.com')));
  } finally {
    await close();
  }
});

test('a failed Google import re-renders the empty builder with the error', async () => {
  const { server, port, close } = await startServer({
    pool: emptyPool(),
    fetchFn: googleImportFetch({ html: '<html>private</html>' }),
  });

  try {
    const res = await postGoogleImport(port, { url: 'https://forms.gle/abc123' });
    const html = await res.text();

    assert.equal(res.status, 400);
    assert.match(html, /illisible/);
    assert.match(html, /name="title"/);
  } finally {
    await close();
  }
});

test('the Google import route is closed to users without the forms role', async () => {
  const { server, port, close } = await startServer({
    pool: emptyPool(),
    fetchFn: googleImportFetch({ memberRoles: [] }),
  });

  try {
    const res = await postGoogleImport(
      port,
      { url: 'https://forms.gle/abc123' },
      { id: '2222222222222222222', username: 'guest', roles: [] },
    );

    assert.equal(res.status, 403);
    assert.doesNotMatch(await res.text(), /Import ponctuel/);
  } finally {
    await close();
  }
});

/** POST du builder vers `/candidatures`, avec la session du créateur. */
test('a choice question without options is refused instead of being saved broken', async () => {
  const { server, port, close } = await startServer({ pool: emptyPool(), fetchFn: discordFetch() });

  try {
    const res = await postBuilder(port, {
      title: 'Recrutement',
      'question_label[]': 'Embarquement ?',
      'question_type[]': 'choice_single',
    });
    const html = await res.text();

    assert.equal(res.status, 400);
    assert.match(html, /au moins une option/);
  } finally {
    await close();
  }
});

test('a choice question with options is accepted', async () => {
  const { server, port, close } = await startServer({ pool: emptyPool(), fetchFn: discordFetch() });

  try {
    const res = await postBuilder(port, {
      title: 'Recrutement',
      'question_label[]': 'Embarquement ?',
      'question_type[]': 'choice_single',
      'question_option[0][]': 'Retour au QG',
      'question_option[0][]': 'Escadrille',
    });
    const html = await res.text();

    // L'enregistrement va échouer sur le pool vide : on vérifie seulement que
    // la validation des options n'a pas bloqué le formulaire.
    assert.doesNotMatch(html, /au moins une option/);
  } finally {
    await close();
  }
});

test('an unsaved question can be duplicated by its row position', async () => {
  const { server, port, close } = await startServer({ pool: emptyPool(), fetchFn: discordFetch() });

  try {
    const res = await postBuilder(port, {
      title: 'Recrutement',
      action: 'duplicate_question:row:0',
      'question_id[]': '',
      'question_label[]': 'Motivation',
      'question_help[]': '',
      'question_type[]': 'short',
    });
    const html = await res.text();

    assert.equal(res.status, 200, 'une action structurelle n’est jamais bloquée par la validation');
    assert.match(html, /Question dupliquée/);
    // Le libellé apparaît deux fois : la première ligne et sa copie.
    const labels = html.match(/name="question_label\[\]"/g) || [];
    assert.equal(labels.length, 2);
  } finally {
    await close();
  }
});

test('an unsaved question can be removed by its row position', async () => {
  const { server, port, close } = await startServer({ pool: emptyPool(), fetchFn: discordFetch() });

  try {
    const res = await postBuilder(port, {
      title: 'Recrutement',
      action: 'remove_question:row:0',
      'question_id[]': '',
      'question_label[]': 'Motivation',
      'question_help[]': '',
      'question_type[]': 'short',
    });
    const html = await res.text();

    assert.equal(res.status, 200);
    assert.match(html, /Question supprimée/);
    assert.equal((html.match(/name="question_label\[\]"/g) || []).length, 0);
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
