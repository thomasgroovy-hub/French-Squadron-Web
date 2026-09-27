import './helpers/env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseGoogleForm } from '../src/routes/forms.js';
import { googleFormHtml, googlePageFetch } from './helpers/google-form.js';

/**
 * Parsing only, no HTTP server: this file stays free of sockets, which keeps the
 * run clean under `--test-force-exit`. The route itself is covered in
 * `forms.test.js`, alongside the other request-level tests.
 */
function parse(html) {
  return parseGoogleForm({ url: 'https://forms.gle/abc123', fetchFn: googlePageFetch(html) });
}

test('the import maps every Google question type it supports', async () => {
  const result = await parse(googleFormHtml());

  assert.equal(result.error, undefined);
  assert.equal(result.title, 'Recrutement Pilote');
  assert.equal(result.description, 'Rejoignez l’escadre.');
  assert.match(result.notice, /6 questions/);

  const questions = result.questions;
  assert.deepEqual(questions.map((question) => question.fieldType), [
    'short',
    'long',
    'choice_single',
    'choice_multiple',
    'date',
    // Une échelle n'existe pas chez nous : on garde le libellé en texte court.
    'short',
  ]);
  assert.deepEqual(questions[0].options, []);
  assert.deepEqual(questions[2].options, ['Retour au QG', 'Escadrille', 'Vol']);
  assert.deepEqual(questions[3].options, ['Matin', 'Après-midi', 'Nuit']);
  assert.equal(questions[1].helpText, 'Quelques lignes suffisent.');
  // Rien n'est encore enregistré : toutes les questions sont sans id.
  assert.ok(questions.every((question) => question.id === null));
});

test('the import tolerates braces and quotes inside question text', async () => {
  const tricky = 'Pseudo {obligatoire} — "ou pas" ; et \\ un \\';
  const result = await parse(googleFormHtml({ items: [{ 1: [[[tricky]], [['']], [['']]], 3: 0 }] }));

  assert.equal(result.error, undefined);
  assert.equal(result.questions[0].label, tricky);
});

test('the import refuses anything that is not a Google Form URL', async () => {
  for (const url of [
    'https://example.com/forms/abc',
    'javascript:alert(1)',
    'https://docs.google.com/document/d/abc/edit',
    'pas une url',
    '',
  ]) {
    const result = await parseGoogleForm({ url, fetchFn: googlePageFetch(googleFormHtml()) });
    assert.ok(result.error, `${url} doit être refusé`);
    assert.equal(result.questions, undefined);
  }
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
    items: [{ 1: [[['Embarquement ?']], [['']], [['']]], 3: 3, 4: [['']] }],
  }));

  assert.equal(result.questions[0].label, 'Embarquement ?');
  assert.equal(result.questions[0].fieldType, 'short');
  assert.deepEqual(result.questions[0].options, []);
});

test('duplicate Google options are merged', async () => {
  const result = await parse(googleFormHtml({
    items: [{ 1: [[['Choix']], [['']], [['']]], 3: 3, 4: [['Oui'], ['Non'], ['Oui ']] }],
  }));

  assert.deepEqual(result.questions[0].options, ['Oui', 'Non']);
});
