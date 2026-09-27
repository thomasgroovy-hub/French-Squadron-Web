import './helpers/env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseGoogleForm } from '../src/routes/forms.js';
import {
  GOOGLE_ITEM_TYPES,
  googleFormHtml,
  googleItem,
  googleOption,
  googlePageFetch,
  legacyGoogleFormHtml,
} from './helpers/google-form.js';

/**
 * Parsing only, no HTTP server: this file stays free of sockets, which keeps the
 * run clean under `--test-force-exit`. The route itself is covered in
 * `forms.test.js`, alongside the other request-level tests.
 */
function parse(html, url = 'https://forms.gle/abc123') {
  return parseGoogleForm({ url, fetchFn: googlePageFetch(html) });
}

test('the import maps every Google question type it supports', async () => {
  const result = await parse(googleFormHtml());

  assert.equal(result.error, undefined);
  assert.equal(result.title, 'Recrutement Pilote');
  assert.equal(result.description, 'Rejoignez l’escadre.');
  assert.match(result.notice, /6 questions/);

  assert.deepEqual(result.questions.map((question) => question.fieldType), [
    'short',
    'long',
    'choice_single',
    'choice_multiple',
    'date',
    // Une échelle n'existe pas chez nous : on garde le libellé en texte court.
    'short',
  ]);
  assert.deepEqual(result.questions[0].options, []);
  assert.deepEqual(result.questions[2].options, ['Retour au QG', 'Escadrille', 'Vol']);
  // L'option « Autre » de Google est vide côté page : on la rebaptise.
  assert.deepEqual(result.questions[3].options, ['Matin', 'Après-midi', 'Autre']);
  assert.equal(result.questions[1].helpText, 'Quelques lignes suffisent.');
  // Rien n'est encore enregistré : toutes les questions sont sans id.
  assert.ok(result.questions.every((question) => question.id === null));
});

test('a dropdown becomes a single choice, like a radio button', async () => {
  const result = await parse(googleFormHtml({
    items: [googleItem({
      label: 'Civilité ?',
      type: GOOGLE_ITEM_TYPES.DROPDOWN,
      options: [googleOption('M.'), googleOption('Mme')],
    })],
  }));

  assert.equal(result.questions[0].fieldType, 'choice_single');
  assert.deepEqual(result.questions[0].options, ['M.', 'Mme']);
});

test('a linear scale is never mistaken for a date question', async () => {
  // Le type 5 est une échelle chez Google, et la date est le type 9 : inverser
  // les deux transformait une note en champ date.
  const result = await parse(googleFormHtml({
    items: [
      googleItem({
        label: 'Notez-nous',
        type: GOOGLE_ITEM_TYPES.SCALE,
        options: [googleOption('1'), googleOption('5')],
      }),
      googleItem({ label: 'Votre date', type: GOOGLE_ITEM_TYPES.DATE }),
    ],
  }));

  assert.equal(result.questions[0].fieldType, 'short');
  assert.equal(result.questions[1].fieldType, 'date');
});

test('sections, images and videos are skipped instead of imported as questions', async () => {
  const result = await parse(googleFormHtml({
    items: [
      googleItem({ label: 'Début du formulaire', type: GOOGLE_ITEM_TYPES.SECTION }),
      googleItem({ label: 'Une photo', type: GOOGLE_ITEM_TYPES.IMAGE }),
      googleItem({ label: 'Une vidéo', type: GOOGLE_ITEM_TYPES.VIDEO }),
      googleItem({ label: 'Pseudo', type: GOOGLE_ITEM_TYPES.SHORT }),
      googleItem({ label: 'Heure', type: GOOGLE_ITEM_TYPES.TIME }),
    ],
  }));

  assert.deepEqual(result.questions.map((question) => question.label), ['Pseudo', 'Heure']);
  assert.equal(result.questions[1].fieldType, 'short');
});

test('the import tolerates braces and quotes inside question text', async () => {
  const tricky = 'Pseudo {obligatoire} — "ou pas" ; et \\ un \\';
  const result = await parse(googleFormHtml({
    items: [googleItem({ label: tricky, type: GOOGLE_ITEM_TYPES.SHORT })],
  }));

  assert.equal(result.error, undefined);
  assert.equal(result.questions[0].label, tricky);
});

test('the import reads the older numeric-key payload', async () => {
  const result = await parse(legacyGoogleFormHtml({ labels: ['Question une', 'Question deux'] }));

  assert.equal(result.error, undefined);
  assert.equal(result.title, 'Ancien format');
  assert.deepEqual(result.questions.map((question) => question.label), ['Question une', 'Question deux']);
});

test('the import refuses anything that is not a Google Form URL', async () => {
  for (const url of [
    'https://example.com/forms/abc',
    'javascript:alert(1)',
    'https://docs.google.com/document/d/abc/edit',
    'pas une url',
    '',
  ]) {
    const result = await parse(googleFormHtml(), url);
    assert.ok(result.error, `${url} doit être refusé`);
    assert.equal(result.questions, undefined);
  }
});

test('the import points at the response link when given the editor URL', async () => {
  // L'URL d'édition renvoie la page de connexion : sans ce cas, l'utilisateur
  // ne verrait qu'un « structure illisible » sans piste.
  const result = await parse(googleFormHtml(), 'https://docs.google.com/forms/d/1FAIpQLSd/edit');

  assert.match(result.error, /éditeur/);
  assert.match(result.error, /viewform/);
});

test('the import explains a private form instead of throwing', async () => {
  const result = await parse('<html><body>Connexion requise</body></html>');

  assert.match(result.error, /illisible/);
  assert.equal(result.questions, undefined);
});

test('the import surfaces an HTTP error from Google', async () => {
  const result = await parseGoogleForm({
    url: 'https://forms.gle/abc123',
    fetchFn: googlePageFetch('', { status: 500 }),
  });

  assert.match(result.error, /500/);
});

test('a network failure is reported as a readable message', async () => {
  const result = await parseGoogleForm({
    url: 'https://forms.gle/abc123',
    fetchFn: async () => { throw new Error('socket hang up'); },
  });

  assert.match(result.error, /socket hang up/);
  assert.doesNotMatch(result.error, /at .*\(.*:\d+:\d+\)/, 'pas de trace technique exposée');
});

test('a choice question with no usable option falls back to a text field', async () => {
  const result = await parse(googleFormHtml({
    items: [googleItem({ label: 'Embarquement ?', type: GOOGLE_ITEM_TYPES.RADIO })],
  }));

  assert.equal(result.questions[0].label, 'Embarquement ?');
  assert.equal(result.questions[0].fieldType, 'short');
  assert.deepEqual(result.questions[0].options, []);
});

test('duplicate Google options are merged', async () => {
  const result = await parse(googleFormHtml({
    items: [googleItem({
      label: 'Choix',
      type: GOOGLE_ITEM_TYPES.RADIO,
      options: [googleOption('Oui'), googleOption('Non'), googleOption('Oui ')],
    })],
  }));

  assert.deepEqual(result.questions[0].options, ['Oui', 'Non']);
});

test('a response entry id is never imported as an option', async () => {
  // Une question à choix de l'ancien format peut n'avoir qu'une validation : le
  // premier nombre est l'id d'entrée, pas une proposition.
  const result = await parse(legacyGoogleFormHtml({
    items: [{ 1: [[['Embarquement ?']], [['']], [['']]], 3: GOOGLE_ITEM_TYPES.RADIO, 4: [[246314205, null, 1]] }],
  }));

  assert.equal(result.questions[0].fieldType, 'short');
  assert.deepEqual(result.questions[0].options, []);
});
