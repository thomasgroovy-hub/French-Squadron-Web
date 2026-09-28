/**
 * Page /documentation : publique, sans base de données et sans éditeur de
 * blocs. Ces tests exercent le rendu réel via les routes HTTP, et la
 * normalisation des URL dans la configuration serveur.
 */
import './helpers/env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import ejs from 'ejs';
import { createApp } from '../src/server.js';
import { webConfig } from '../src/config.js';

const run = promisify(execFile);
const projectRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const viewsDir = path.join(projectRoot, 'src', 'views');

async function startServer() {
  const server = http.createServer(createApp({ pool: null }));
  await new Promise((resolve) => server.listen(0, resolve));
  return { port: server.address().port, close: () => server.close() };
}

async function openDocumentation() {
  const { port, close } = await startServer();
  const res = await fetch(`http://localhost:${port}/documentation`, { redirect: 'manual' });
  const html = await res.text();
  const main = html.match(/<main class="container">([\s\S]*?)<\/main>/)?.[1] || '';
  const nav = html.match(/<div class="nav-tabs"[\s\S]*?<\/div>/)?.[0] || '';
  return { res, html, main, nav, close };
}

/**
 * Relit `src/config.js` dans un interpréteur neuf : la configuration est
 * évaluée une seule fois au chargement du module, on ne peut donc pas la
 * faire varier en cours de test.
 */
async function configWith(overrides) {
  const script = "const { webConfig } = await import('./src/config.js');"
    + ' console.log(JSON.stringify({'
    + '  ethics: webConfig.documentationEthicsUrl,'
    + '  facility: webConfig.documentationFacilityUrl,'
    + '  discord: webConfig.discordUrl,'
    + '}));';
  const { stdout } = await run(process.execPath, ['--input-type=module', '-e', script], {
    cwd: projectRoot,
    env: { ...process.env, ...overrides },
  });
  return JSON.parse(stdout);
}

test('la page /documentation répond sans connexion et rend ses trois cartes', async () => {
  const { res, main, close } = await openDocumentation();

  try {
    assert.equal(res.status, 200, 'aucune redirection OAuth n’est demandée');
    assert.match(main, /Charte<\/h1>|Documentation de l’escadrille/);
    assert.equal(main.match(/class="card shortcut"/g)?.length, 3);
    assert.match(main, /Charte éthique/);
    assert.match(main, /Charte de l’installation/);
    assert.match(main, /texte normatif suprême de la Fondation de Procédures de Confinement Spéciales/);
    assert.match(main, /Utiliser par le département administratif/);
    assert.match(main, /serveur Discord de la Fondation et de l’installation/);
  } finally {
    close();
  }
});

test('chaque carte ouvre son URL configurée dans un nouvel onglet, en toute sécurité', async () => {
  const { html, main, close } = await openDocumentation();

  try {
    const links = [...main.matchAll(/<a class="card shortcut"([^>]*)>/g)].map((match) => match[1]);
    assert.equal(links.length, 3);
    for (const attributes of links) {
      assert.match(attributes, /target="_blank"/);
      assert.match(attributes, /rel="noopener noreferrer"/);
    }

    // Les URL viennent de la configuration, jamais du template.
    assert.ok(main.includes(`href="${webConfig.documentationEthicsUrl}"`), 'carte Charte éthique');
    assert.ok(main.includes(`href="${webConfig.documentationFacilityUrl}"`), 'carte Charte de l’installation');
    assert.ok(main.includes(`href="${webConfig.discordUrl}"`), 'carte Discord');
    // Le lien du footer pointe sur la même variable, et sur elle seule.
    assert.ok(html.includes(`href="${webConfig.discordUrl}" target="_blank" rel="noopener noreferrer">Discord</a>`));
  } finally {
    close();
  }
});

test('l’ancien éditeur de blocs a disparu de la page', async () => {
  const { main, close } = await openDocumentation();

  try {
    assert.doesNotMatch(main, /<form/, 'aucun formulaire ne doit subsister');
    assert.doesNotMatch(main, /documentation est vide|Aucun contenu n/);
    assert.doesNotMatch(main, /documentation\/blocs|data-insert|doc-edit|doc-reorder-form/);
    assert.doesNotMatch(main, /draggable=|block_type|textarea|<select/);
  } finally {
    close();
  }
});

test('l’onglet Documentation a quitté la navigation, la route reste en place', async () => {
  const { res, nav, close } = await openDocumentation();

  try {
    assert.doesNotMatch(nav, /Documentation/, 'plus aucun onglet entre Candidatures et Réponses');
    assert.match(nav, /href="\/candidatures"/);
    assert.equal(res.status, 200, '/documentation reste directement accessible');
  } finally {
    close();
  }
});

test('une carte sans URL reste lisible, mais n’est plus un lien', () => {
  const filename = path.join(viewsDir, 'documentation.ejs');
  const cards = [
    { key: 'ethics', title: 'Charte éthique', description: 'Texte.', url: '/' },
    { key: 'discord', title: 'Discord', description: 'Serveur.', url: '' },
  ];
  const html = ejs.render(fs.readFileSync(filename, 'utf8'), { cards }, { filename });

  assert.match(html, /<a class="card shortcut" href="\/" target="_blank" rel="noopener noreferrer">/);
  assert.match(html, /<a class="card shortcut" aria-disabled="true">/);
  // Une seule ancre cliquable : celle qui a une URL.
  assert.equal(html.match(/target="_blank"/g)?.length, 1);
});

test('les descriptions et titres sont échappés, jamais rendus comme du balisage', () => {
  const filename = path.join(viewsDir, 'documentation.ejs');
  const cards = [{
    key: 'ethics',
    title: '<img src=x onerror=alert(1)>',
    description: '"><script>alert(1)</script>',
    url: 'https://example.test/?a=1&b=2',
  }];
  const html = ejs.render(fs.readFileSync(filename, 'utf8'), { cards }, { filename });

  assert.doesNotMatch(html, /<img src=x/);
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.match(html, /href="https:\/\/example\.test\/\?a=1&amp;b=2"/);
  assert.doesNotMatch(html, /&amp;amp;/);
});

test('sans variable d’environnement, la configuration retombe sur des placeholders sûrs', async () => {
  const config = await configWith({
    DOCUMENTATION_ETHICS_URL: '',
    DOCUMENTATION_FACILITY_URL: '',
    DISCORD_URL: '',
  });

  assert.equal(config.ethics, '/', 'la documentation renvoie vers le site, pas vers une URL cassée');
  assert.equal(config.facility, '/');
  assert.equal(config.discord, '', 'aucun repli inventé pour Discord');
});

test('une URL qui n’est pas http(s) est refusée par la configuration', async () => {
  const config = await configWith({
    DOCUMENTATION_ETHICS_URL: 'javascript:alert(1)',
    DOCUMENTATION_FACILITY_URL: '/documentation/interne',
    DISCORD_URL: 'data:text/html,<script>alert(1)</script>',
  });

  assert.equal(config.ethics, '/');
  assert.equal(config.facility, '/', 'un chemin relatif n’est pas une URL de lien externe');
  assert.equal(config.discord, '');
});

test('aucune invitation Discord n’est écrite en dur dans le code', () => {
  const offenders = [];
  const walk = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      // Une invitation est un lien court : c'est elle qui doit venir de DISCORD_URL.
      const hardcoded = fs.readFileSync(full, 'utf8').match(/https?:\/\/discord\.gg\/\S+/g) || [];
      if (hardcoded.length) offenders.push(`${path.relative(projectRoot, full)}: ${hardcoded.join(', ')}`);
    }
  };
  walk(path.join(projectRoot, 'src'));

  assert.deepEqual(offenders, []);
});
