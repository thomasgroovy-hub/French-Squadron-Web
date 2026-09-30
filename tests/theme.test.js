/**
 * Thème sombre/clair : thème sombre par défaut, bascule immédiate et
 * persistance via localStorage. Ces tests vérifient le balisage et le CSS
 * livrés dans le HTML, pas un navigateur réel.
 */
import './helpers/env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sealSession } from '../src/auth/session.js';
import { createApp } from '../src/server.js';
import { webConfig } from '../src/config.js';
import { createFakePool } from './helpers/fake-mysql.js';

const layoutCss = fs.readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'views', 'layout.ejs'),
  'utf8',
);

const FORMS_ROLE = '1532037579816570981';
const STAFF_ROLE = '1553099793532854382';

const cookie = (user) => `${webConfig.cookieName}=${sealSession({ user }, webConfig.sessionSecret)}`;
const MANAGER = { id: 'manager-1', username: 'Recruteur', globalName: 'Chef', avatarUrl: null };

const fetchFn = async (url, options = {}) => {
  if (url.endsWith('/roles') && !options.method) {
    return {
      ok: true,
      status: 200,
      json: async () => [
        { id: FORMS_ROLE, name: 'Recruteurs' },
        { id: STAFF_ROLE, name: 'Supervision' },
      ],
    };
  }
  if (/\/guilds\/[^/]+\/members\/[^/]+$/.test(url)) {
    return { ok: true, status: 200, json: async () => ({ roles: [FORMS_ROLE, STAFF_ROLE] }) };
  }
  return { ok: false, status: 404, json: async () => ({}) };
};

async function withApp(run) {
  const pool = createFakePool();
  const server = http.createServer(createApp({ pool, fetchFn }));
  await new Promise((resolve) => server.listen(0, resolve));
  const port = server.address().port;
  const get = (path, as = MANAGER) => fetch(`http://localhost:${port}${path}`, {
    headers: { Cookie: cookie(as) },
    redirect: 'manual',
  });
  try {
    await run({ get, pool });
  } finally {
    server.close();
  }
}

/**
 * Contrastes WCAG des deux palettes. Les valeurs sont lues dans layout.ejs
 * pour que le test suive toute modification future des variables CSS.
 */
function parsePalette(selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const start = layoutCss.search(new RegExp(`^\\s*${escaped}\\s*\\{`, 'm'));
  assert.notEqual(start, -1, `palette ${selector} introuvable`);

  const tokens = {};
  for (const line of layoutCss.slice(start).split('\n').slice(1)) {
    if (/^\s*\}/.test(line)) break;
    const declaration = line.match(/(--[a-z-]+):\s*(#[0-9a-fA-F]{3,8})\s*;/);
    if (declaration) tokens[declaration[1]] = declaration[2];
  }
  return tokens;
}

const toRgb = (hex) => {
  let h = hex.replace('#', '');
  if (h.length === 3) h = [...h].map((c) => c + c).join('');
  const n = Number.parseInt(h, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
};

const contrast = (a, b) => {
  const lum = (rgb) => 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];
  const l1 = lum(toRgb(a));
  const l2 = lum(toRgb(b));
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
};

const CONTRAST_CHECKS = [
  ['texte principal / fond', '--text-main', '--bg-main', 4.5],
  ['texte principal / carte', '--text-main', '--bg-card', 4.5],
  ['texte principal / carte surélevée', '--text-main', '--bg-elevated', 4.5],
  ['texte principal / discret', '--text-main', '--bg-subtle', 4.5],
  ['texte attenue / carte', '--text-muted', '--bg-card', 4.5],
  ['lien accent / fond', '--accent', '--bg-main', 4.5],
  ['lien accent / carte', '--accent', '--bg-card', 4.5],
  ['danger / fond', '--danger', '--bg-main', 4.5],
  ['warning / fond', '--warning', '--bg-main', 4.5],
  ['success / fond', '--success', '--bg-main', 4.5],
  ['danger / fond danger', '--danger', '--danger-bg', 4.5],
  ['warning / fond warning', '--warning', '--warning-bg', 4.5],
  ['success / fond success', '--success', '--success-bg', 4.5],
];

test('les deux palettes respectent le contraste WCAG AA', () => {
  for (const selector of [':root', '[data-theme="dark"]']) {
    const palette = parsePalette(selector);
    for (const [label, fg, bg, min] of CONTRAST_CHECKS) {
      assert.ok(palette[fg], `${selector} doit définir ${fg}`);
      assert.ok(palette[bg], `${selector} doit définir ${bg}`);
      const ratio = contrast(palette[fg], palette[bg]);
      assert.ok(
        ratio >= min,
        `${selector} — ${label} : ${ratio.toFixed(2)} < ${min}`,
      );
    }
  }
});

/** Les six pages demandées pour la vérification visuelle. */
const PAGES = [
  ['Accueil', '/'],
  ['Profil', '/profile'],
  ['Candidatures', '/candidatures'],
  ['Documentation', '/documentation'],
  ['Réponses', '/reponses'],
  ['Supervision', '/members'],
];

test('le thème sombre est la valeur par défaut sur les six pages', async () => {
  await withApp(async ({ get }) => {
    for (const [label, path] of PAGES) {
      const html = await (await get(path)).text();
      assert.match(html, /<html lang="fr" data-theme="dark">/, `${label} (/${path}) démarre en sombre`);
    }
  });
});

test('le script anti-flash applique le thème avant le premier rendu', async () => {
  await withApp(async ({ get }) => {
    const html = await (await get('/')).text();

    const head = html.slice(0, html.indexOf('</head>'));
    const scriptIndex = head.indexOf("site66-theme");
    assert.ok(scriptIndex !== -1, 'la clé de stockage est présente dans le head');
    assert.ok(
      head.indexOf("setAttribute('data-theme'") < head.indexOf('<style>'),
      'le script qui pose data-theme précède la feuille de style',
    );
    assert.match(head, /localStorage\.getItem\(STORAGE_KEY\)/);
    assert.match(head, /stored === 'light' \|\| stored === 'dark' \? stored : 'dark'/);
  });
});

test('le thème est piloté par data-theme et les deux palettes sont définies', async () => {
  await withApp(async ({ get }) => {
    const html = await (await get('/')).text();

    assert.match(html, /\[data-theme="dark"\]/, 'la palette sombre est définie');
    assert.match(html, /\[data-theme="light"\]/, 'la palette claire est définie');

    // Chaque couleur d'accent de la palette sombre doit être réellement
    // déclarée, sinon le basculement laisserait des surfaces illisibles.
    for (const token of [
      '--bg-main', '--bg-card', '--bg-subtle', '--bg-pill', '--bg-elevated',
      '--border', '--border-strong', '--text-main', '--text-muted',
      '--accent', '--accent-hover', '--danger', '--warning', '--success',
    ]) {
      const occurrences = html.match(new RegExp(token.replace('--', '--'), 'g')) || [];
      assert.ok(occurrences.length >= 2, `${token} doit exister dans les deux palettes`);
    }
  });
});

test('le bouton de bascule est présent et accessible sur chaque page', async () => {
  await withApp(async ({ get }) => {
    for (const [label, path] of PAGES) {
      const html = await (await get(path)).text();
      assert.match(html, /id="theme-toggle"/, `${label} (${path}) doit exposer la bascule`);
      assert.match(html, /aria-label="Basculer entre le mode sombre et le mode clair"/);
    }
  });
});

test('la bascule ne dépend d’aucun rechargement et persiste le choix', async () => {
  await withApp(async ({ get }) => {
    const html = await (await get('/')).text();

    assert.match(html, /toggle\.addEventListener\('click'/, 'le clic est géré en JavaScript');
    assert.match(html, /localStorage\.setItem\(STORAGE_KEY, resolved\)/, 'le choix est persisté');
    assert.match(html, /getAttribute\('data-theme'\) === 'light' \? 'dark' : 'light'/, 'la bascule inverse le thème');
    assert.doesNotMatch(html, /theme-toggle[^>]*\shref=/, 'ce n’est pas un lien, donc pas de navigation');
  });
});

test('aucune couleur claire codée en dur ne casse le thème sombre', async () => {
  await withApp(async ({ get }) => {
    for (const [label, path] of PAGES) {
      const html = await (await get(path)).text();
      const head = html.slice(0, html.indexOf('</head>'));

      // Seules les trois palettes déclarées (claire, sombre, rose) et la couleur
      // de marque Discord utilisent des littéraux. Toute autre couleur en dur
      // casserait le basculement de thème.
const declared = new Set(['#f7f7f8', '#ffffff', '#e5e7eb', '#d1d5db', '#111827', '#6b7280',
  '#71717A', '#52525B', '#E53E3E', '#3A1C1C', '#E5A00F', '#362A10',
  '#22C55E', '#102C1E', '#e8eaed', '#9aa3b2', '#526d68', '#62857c', '#fff',
  // Theme rose (easter egg) : la palette est scoped par [data-theme="rose"].
  '#2a141c', '#351922', '#40202a', '#4a2531', '#3d1d26', '#5c2f3d', '#7a3f52',
  '#ffeef4', '#d9a7b9', '#ff9ebb', '#ffb8cd', '#ff8fa8', '#4d1f2b', '#ffc98a',
  '#4d3520', '#ffa8c4', '#4a2130', '#09090B', '#0F0F11', '#111113', '#18181B',
  '#27272A', '#3F3F46', '#F4F4F5', '#A1A1AA', '#71717A', '#52525B',
  '#E53E3E', '#3A1C1C', '#E5A00F', '#362A10', '#22C55E', '#102C1E',
  '#526d68', '#62857c', '#fff'
]);
      // La comparaison ignore la casse : la palette sombre est écrite en
      // majuscules, le littéral trouvé dans le HTML est normalisé en minuscules.
      const allowed = new Set([...declared].map((hex) => hex.toLowerCase()));

      const hardcoded = [...head.matchAll(/(?:background|background-color|color)\s*:\s*(#[0-9a-f]{3,8})/gi)]
        .map((m) => m[1].toLowerCase())
        .filter((hex) => !allowed.has(hex));

      assert.deepEqual(hardcoded, [], `${label} (${path}) contient des couleurs en dur: ${hardcoded.join(', ')}`);
    }
  });
});

test('l’anneau décoratif de l’accueil n’existe que sur l’accueil', async () => {
  await withApp(async ({ get }) => {
    const dashboard = await (await get('/')).text();
    assert.match(dashboard, /\.dashboard-hero::after/, 'l’accueil porte sa décoration');
    assert.match(dashboard, /<section class="card dashboard-hero">/);

    for (const [label, path] of PAGES.slice(1)) {
      const html = await (await get(path)).text();
      assert.doesNotMatch(html, /\.dashboard-hero::after/, `${label} ne doit pas porter l’anneau`);
      assert.doesNotMatch(html, /class="card dashboard-hero"/, `${label} ne doit pas rendre le hero`);
    }
  });
});
