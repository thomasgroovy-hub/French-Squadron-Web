/**
 * Security regression suite: CSRF, rate limits, security headers/CSP,
 * session lifetime and logout revocation, OAuth error handling, body limits,
 * and the permadeath webhook signature scheme.
 */
import './helpers/env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import { sealSession, unsealSession } from '../src/auth/session.js';
import { deriveCsrfToken } from '../src/security/csrf.js';
import { formsAccessMessages } from '../src/auth/guards.js';
import { createApp } from '../src/server.js';
import { webConfig } from '../src/config.js';

const MANAGER = { id: 'manager-1', username: 'Recruteur', globalName: 'Chef Recruteur', avatarUrl: null };
const SNOWFLAKE_RE = /^[0-9a-f]{64}$/;

function auth(user) {
  // Real sessions always carry a sid (see session.js setSession): the logout
  // revocation test needs one too, since the blacklist is keyed by sid.
  const sealed = sealSession({ user, sid: crypto.randomBytes(16).toString('hex') }, webConfig.sessionSecret);
  return {
    cookie: `${webConfig.cookieName}=${sealed}`,
    csrf: deriveCsrfToken(unsealSession(sealed), webConfig.sessionSecret),
  };
}

/** Reproduces the seal format so a session can be crafted already expired. */
function sealAged(payload, secret, ageMs) {
  const iv = crypto.randomBytes(12);
  const key = crypto.createHash('sha256').update(secret).digest();
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  let encrypted = cipher.update(JSON.stringify({ ...payload, _created: Date.now() - ageMs }), 'utf8', 'base64');
  encrypted += cipher.final('base64');
  return `${iv.toString('base64')}.${cipher.getAuthTag().toString('base64')}.${encrypted}`;
}

async function start(options = {}) {
  const server = http.createServer(createApp(options));
  await new Promise((resolve) => server.listen(0, resolve));
  const { port } = server.address();
  return {
    server,
    port,
    url: (path) => `http://localhost:${port}${path}`,
    close: () => server.close(),
  };
}

const noRoleFetch = async (url) => {
  if (/\/guilds\/[^/]+\/members\/[^/]+$/.test(String(url))) {
    return { ok: true, status: 200, json: async () => ({ roles: [] }) };
  }
  return { ok: false, status: 404, json: async () => ({}) };
};

// -- Headers ------------------------------------------------------------------

test('every response carries hardening headers and a nonce-bound CSP', async () => {
  const app = await start({ pool: null });
  try {
    const res = await fetch(app.url('/'));
    assert.equal(res.status, 200);
    assert.ok(res.headers.get('content-security-policy'), 'CSP present');
    assert.match(res.headers.get('content-security-policy'), /script-src 'self' 'nonce-[A-Za-z0-9+/=]+'/);
    assert.match(res.headers.get('content-security-policy'), /frame-ancestors 'none'/);
    assert.doesNotMatch(res.headers.get('content-security-policy'), /unsafe-eval/);
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(res.headers.get('x-frame-options'), 'DENY');
    assert.equal(res.headers.get('referrer-policy'), 'strict-origin-when-cross-origin');
    assert.equal(res.headers.get('x-powered-by'), null, 'x-powered-by is disabled');
    assert.equal(res.headers.get('cache-control'), 'no-store');

    const cspNonce = res.headers.get('content-security-policy').match(/'nonce-([^']+)'/)[1];
    const html = await res.text();
    assert.ok(html.includes(`<script nonce="${cspNonce}">`), 'inline scripts use the response nonce');
    assert.ok(!/<script>(?!<\/script>)/.test(html.replace(/<script nonce="[^"]+">/g, '')), 'no bare inline script');
  } finally {
    app.close();
  }
});

// -- CSRF ---------------------------------------------------------------------

test('authenticated POST without a CSRF token is refused before any route runs', async () => {
  const app = await start({ pool: null, fetchFn: noRoleFetch });
  try {
    const { cookie } = auth(MANAGER);
    const res = await fetch(app.url('/candidatures'), {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'title=Pirate',
      redirect: 'manual',
    });
    assert.equal(res.status, 403);
    assert.match(await res.text(), /Jeton de sécurité/);
  } finally {
    app.close();
  }
});

test('a valid CSRF token passes through to the route guard', async () => {
  const app = await start({ pool: null, fetchFn: noRoleFetch });
  try {
    const { cookie, csrf } = auth(MANAGER);
    const res = await fetch(app.url('/candidatures'), {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `title=Pirate&_csrf=${encodeURIComponent(csrf)}`,
      redirect: 'manual',
    });
    assert.equal(res.status, 403, 'the forms-role guard still answers');
    assert.ok((await res.text()).includes(formsAccessMessages.denied));
  } finally {
    app.close();
  }
});

test('the CSRF token also travels as the x-csrf-token header', async () => {
  const app = await start({ pool: null, fetchFn: noRoleFetch });
  try {
    const { cookie, csrf } = auth(MANAGER);
    const res = await fetch(app.url('/candidatures'), {
      method: 'POST',
      headers: {
        Cookie: cookie,
        'x-csrf-token': csrf,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: 'title=Pirate',
      redirect: 'manual',
    });
    assert.equal(res.status, 403);
    assert.ok((await res.text()).includes(formsAccessMessages.denied));
  } finally {
    app.close();
  }
});

test('a forged CSRF token is refused', async () => {
  const app = await start({ pool: null, fetchFn: noRoleFetch });
  try {
    const { cookie } = auth(MANAGER);
    const res = await fetch(app.url('/candidatures'), {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'title=Pirate&_csrf=deadbeef'.padEnd(160, '0'),
      redirect: 'manual',
    });
    assert.equal(res.status, 403);
    assert.match(await res.text(), /Jeton de sécurité/);
  } finally {
    app.close();
  }
});

test('anonymous POSTs keep falling through to requireAuth (redirect to login)', async () => {
  const app = await start({ pool: null, fetchFn: noRoleFetch });
  try {
    const res = await fetch(app.url('/candidatures'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'title=Pirate',
      redirect: 'manual',
    });
    assert.equal(res.status, 302);
    assert.equal(res.headers.get('location'), '/auth/discord');
  } finally {
    app.close();
  }
});

test('authenticated pages render the token in the logout link and in forms', async () => {
  const app = await start({ pool: null, fetchFn: noRoleFetch });
  try {
    const { cookie, csrf } = auth(MANAGER);
    const res = await fetch(app.url('/'), { headers: { Cookie: cookie } });
    const html = await res.text();
    assert.match(html, new RegExp(`href="/auth/logout\\?_csrf=${csrf}"`));
  } finally {
    app.close();
  }
});

// -- Session lifetime and logout ---------------------------------------------

test('an expired session is treated as anonymous server-side', async () => {
  const app = await start({ pool: null });
  try {
    const expired = `${webConfig.cookieName}=${sealAged({ user: MANAGER }, webConfig.sessionSecret, 8 * 24 * 60 * 60 * 1000)}`;
    // A live session would answer 403 here (logout without a token); an
    // expired one is discarded and behaves like any anonymous request.
    const res = await fetch(app.url('/auth/logout'), {
      headers: { Cookie: expired },
      redirect: 'manual',
    });
    assert.equal(res.status, 302);
    assert.equal(res.headers.get('location'), '/');
  } finally {
    app.close();
  }
});

test('logout requires the CSRF token when a session exists', async () => {
  const app = await start({ pool: null });
  try {
    const { cookie } = auth(MANAGER);
    const blocked = await fetch(app.url('/auth/logout'), {
      headers: { Cookie: cookie },
      redirect: 'manual',
    });
    assert.equal(blocked.status, 403, 'forced logout from another site is blocked');

    const { cookie: cookie2, csrf } = auth(MANAGER);
    const allowed = await fetch(app.url(`/auth/logout?_csrf=${csrf}`), {
      headers: { Cookie: cookie2 },
      redirect: 'manual',
    });
    assert.equal(allowed.status, 302);
    assert.match(allowed.headers.get('set-cookie') || '', /fpcs_session=;/);
  } finally {
    app.close();
  }
});

test('a session is revoked server-side at logout, not only via the cookie', async () => {
  const app = await start({ pool: null });
  try {
    const { cookie, csrf } = auth(MANAGER);
    // Still alive: logout without the token must be refused (403).
    const beforeLogout = await fetch(app.url('/auth/logout'), {
      headers: { Cookie: cookie },
      redirect: 'manual',
    });
    assert.equal(beforeLogout.status, 403);

    const done = await fetch(app.url(`/auth/logout?_csrf=${csrf}`), {
      headers: { Cookie: cookie },
      redirect: 'manual',
    });
    assert.equal(done.status, 302);

    // The client kept the old cookie: the sid blacklist must discard it.
    const afterLogout = await fetch(app.url('/auth/logout'), {
      headers: { Cookie: cookie },
      redirect: 'manual',
    });
    assert.equal(afterLogout.status, 302, 'the old cookie no longer carries a live session');
    assert.equal(afterLogout.headers.get('location'), '/');
  } finally {
    app.close();
  }
});

// -- OAuth --------------------------------------------------------------------

test('the OAuth callback never reflects error_description into the page', async () => {
  const app = await start({ pool: null, fetchFn: async () => ({ ok: false, status: 500 }) });
  try {
    const res = await fetch(
      app.url('/auth/discord/callback?error=access_denied&error_description=%3Cimg%20src%3Dx%20onerror%3Dalert(1)%3E'),
      { redirect: 'manual' },
    );
    assert.equal(res.status, 400);
    const html = await res.text();
    assert.doesNotMatch(html, /onerror/);
    assert.doesNotMatch(html, /<img/);
  } finally {
    app.close();
  }
});

test('the session cookie is HttpOnly and SameSite', async () => {
  const fakeFetch = async (url) => {
    if (String(url).includes('/oauth2/token')) {
      return { ok: true, json: async () => ({ access_token: 'tok', token_type: 'Bearer' }) };
    }
    if (String(url).includes('/users/@me')) {
      return {
        ok: true,
        json: async () => ({
          id: '123456789012345678',
          username: 'tester',
          global_name: 'Tester',
          avatar: null,
        }),
      };
    }
    return { ok: false, status: 404 };
  };
  const app = await start({ pool: null, fetchFn: fakeFetch });
  try {
    const res = await fetch(app.url('/auth/discord/callback?code=good&state=ok'), {
      headers: { Cookie: 'oauth_state=ok' },
      redirect: 'manual',
    });
    assert.equal(res.status, 302);
    const setCookie = (res.headers.get('set-cookie') || '').toLowerCase();
    assert.match(setCookie, /fpcs_session=/);
    assert.match(setCookie, /httponly/);
    assert.match(setCookie, /samesite=lax/);
  } finally {
    app.close();
  }
});

// -- Rate limiting ------------------------------------------------------------

test('the /auth limiter answers 429 with Retry-After after the budget is spent', async () => {
  const app = await start({ pool: null });
  try {
    let last;
    for (let i = 0; i <= 60; i += 1) {
      last = await fetch(app.url('/auth/discord'), { redirect: 'manual' });
    }
    assert.equal(last.status, 429);
    assert.ok(last.headers.get('retry-after'), 'Retry-After is set');
    assert.match(await last.text(), /429/);
  } finally {
    app.close();
  }
});

test('the webhook limiter answers 429 as JSON under /v1', async () => {
  const app = await start({ pool: null });
  try {
    let last;
    for (let i = 0; i <= 60; i += 1) {
      last = await fetch(app.url('/v1/roblox/permadeath-death'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      });
    }
    assert.equal(last.status, 429);
    const payload = await last.json();
    assert.equal(payload.error, 'rate-limited');
  } finally {
    app.close();
  }
});

// -- Body limits --------------------------------------------------------------

test('oversized form payloads are rejected with 413', async () => {
  const app = await start({ pool: null });
  try {
    const res = await fetch(app.url('/'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `payload=${'a'.repeat(600_000)}`,
      redirect: 'manual',
    });
    assert.equal(res.status, 413);
    assert.match(await res.text(), /trop volumineuse/i);
  } finally {
    app.close();
  }
});

// -- Permadeath webhook -------------------------------------------------------

const WEBHOOK_SECRET = webConfig.permadeathWebhookSecret;
const STAFF_OK = '999888777666555444';

function hmacOf(data) {
  return crypto.createHmac('sha256', WEBHOOK_SECRET).update(data).digest('hex');
}

function deathPool() {
  const inserts = [];
  return {
    inserts,
    execute: async (query, params = []) => {
      if (/SELECT 1 FROM permadeath_deaths/.test(query)) return [[]];
      if (/INSERT INTO permadeath_deaths/.test(query)) {
        inserts.push(params);
        return [{ insertId: 1, affectedRows: 1 }];
      }
      return [[]];
    },
  };
}

const staffFetch = (roles) => async (url) => {
  if (/\/guilds\/[^/]+\/members\/[^/]+$/.test(String(url))) {
    return { ok: true, status: 200, json: async () => ({ roles }) };
  }
  return { ok: false, status: 404, json: async () => ({}) };
};

function postWebhook(app, body, { signature, timestamp } = {}) {
  const raw = JSON.stringify(body);
  const headers = { 'Content-Type': 'application/json' };
  if (signature !== undefined) headers['x-signature'] = signature;
  if (timestamp !== undefined) headers['x-signature-timestamp'] = String(timestamp);
  return fetch(app.url('/v1/roblox/permadeath-death'), {
    method: 'POST',
    headers,
    body: raw,
  });
}

test('the webhook refuses unsigned and badly signed deliveries', async () => {
  const pool = deathPool();
  const app = await start({ pool, fetchFn: staffFetch([]) });
  try {
    const body = { discordUserId: '111222333444555666', robloxUserId: '111', eventId: 'e-unsigned' };
    const unsigned = await postWebhook(app, body);
    assert.equal(unsigned.status, 401);

    const forged = await postWebhook(app, body, { signature: hmacOf('not-the-body') });
    assert.equal(forged.status, 401);
    assert.equal(pool.inserts.length, 0);
  } finally {
    app.close();
  }
});

test('a correctly signed delivery is recorded, and its exact replay refused', async () => {
  const pool = deathPool();
  const app = await start({ pool, fetchFn: staffFetch([]) });
  try {
    const body = { discordUserId: '111222333444555666', robloxUserId: '222', eventId: 'e-replay-1' };
    const signature = hmacOf(JSON.stringify(body));

    const first = await postWebhook(app, body, { signature });
    assert.equal(first.status, 200);
    assert.equal(pool.inserts.length, 1);
    assert.equal(pool.inserts[0][0], '111222333444555666');

    const replay = await postWebhook(app, body, { signature });
    assert.equal(replay.status, 409, 'an identical delivery is a duplicate');
    assert.equal(pool.inserts.length, 1, 'no second insert');
  } finally {
    app.close();
  }
});

test('the timestamp scheme signs timestamp.body and enforces a freshness window', async () => {
  const pool = deathPool();
  const app = await start({ pool, fetchFn: staffFetch([]) });
  try {
    const body = { discordUserId: '111222333444555666', robloxUserId: '333', eventId: 'e-ts-1' };
    const raw = JSON.stringify(body);

    const nowTs = Math.floor(Date.now() / 1000);
    const fresh = await postWebhook(app, body, {
      signature: hmacOf(`${nowTs}.${raw}`),
      timestamp: nowTs,
    });
    assert.equal(fresh.status, 200);

    const staleTs = Math.floor(Date.now() / 1000) - 600;
    const stale = await postWebhook(app, body, {
      signature: hmacOf(`${staleTs}.${raw}`),
      timestamp: staleTs,
    });
    assert.equal(stale.status, 401, 'a stale timestamp is refused even with a valid HMAC');
  } finally {
    app.close();
  }
});

test('a delivery with neither event id nor timestamp is refused (no replay defense)', async () => {
  const pool = deathPool();
  const app = await start({ pool, fetchFn: staffFetch([]) });
  try {
    const body = { discordUserId: '111222333444555666', robloxUserId: '444' };
    const res = await postWebhook(app, body, { signature: hmacOf(JSON.stringify(body)) });
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, /event_id or x-signature-timestamp/);
    assert.equal(pool.inserts.length, 0);
  } finally {
    app.close();
  }
});

test('staffDiscordId is validated and role-checked against Discord', async () => {
  const pool = deathPool();
  const app = await start({ pool, fetchFn: staffFetch([]) });
  try {
    const malformed = { discordUserId: '111222333444555666', robloxUserId: '555', eventId: 'e-bad-staff', staffDiscordId: '../../etc' };
    const bad = await postWebhook(app, malformed, { signature: hmacOf(JSON.stringify(malformed)) });
    assert.equal(bad.status, 400);

    const noRole = { discordUserId: '111222333444555666', robloxUserId: '555', eventId: 'e-no-role', staffDiscordId: STAFF_OK };
    const refused = await postWebhook(app, noRole, { signature: hmacOf(JSON.stringify(noRole)) });
    assert.equal(refused.status, 403, 'a staff id without the member management role is refused');
    assert.equal(pool.inserts.length, 0);
  } finally {
    app.close();
  }
});

test('a staff member holding the member management role passes the check', async () => {
  const pool = deathPool();
  const app = await start({ pool, fetchFn: staffFetch([webConfig.memberManagementRoleId]) });
  try {
    const body = {
      discordUserId: '111222333444555666',
      robloxUserId: '666',
      eventId: 'e-staff-ok',
      staffDiscordId: STAFF_OK,
    };
    const res = await postWebhook(app, body, { signature: hmacOf(JSON.stringify(body)) });
    assert.equal(res.status, 200);
    assert.equal(pool.inserts.length, 1);
  } finally {
    app.close();
  }
});
