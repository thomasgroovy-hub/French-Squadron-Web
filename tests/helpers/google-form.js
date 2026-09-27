/**
 * Fixture de la charge utile `FB_PUBLIC_LOAD_DATA_` d'un Google Form public,
 * calquée sur les pages `viewform` réellement servies par Google.
 *
 * Tout y est positionnel : `loadData[1][0]` porte la description,
 * `loadData[1][1]` les items et `loadData[1][8]` le titre. Chaque item est un
 * tableau `[id, libellé, description, type, validation, …]` et les options vivent
 * dans la validation, `item[4][0][1]`. Partagée par les tests du parseur et ceux
 * de la route.
 */

/** `["1", null, null, null, 0]`, le drapeau final valant 1 sur l'option « Autre ». */
export function googleOption(text, isOther = false) {
  return [text, null, null, null, isOther ? 1 : 0];
}

let nextItemId = 822815793;

/** Un item de question dans le format réellement servi par Google. */
export function googleItem({ id, label, description = null, type, options = null, required = 1 } = {}) {
  const itemId = id ?? (nextItemId += 7);
  return [
    itemId,
    label,
    description,
    type,
    [[1000000000 + itemId, options, required]],
    null, null, null, null, null, null,
    [null, label],
    description ? [null, description] : null,
  ];
}

/** Codes de type observés sur les pages publiques de Google. */
export const GOOGLE_ITEM_TYPES = Object.freeze({
  SHORT: 0,
  PARAGRAPH: 1,
  RADIO: 2,
  DROPDOWN: 3,
  CHECKBOX: 4,
  SCALE: 5,
  IMAGE: 6,
  VIDEO: 7,
  SECTION: 8,
  DATE: 9,
  TIME: 10,
  STAR: 18,
});

export function googleFormHtml({
  title = 'Recrutement Pilote',
  description = 'Rejoignez l’escadre.',
  items = [
    googleItem({ id: 822815793, label: 'Quel est votre pseudo ?', type: GOOGLE_ITEM_TYPES.SHORT }),
    googleItem({
      id: 702392112,
      label: 'Présentez-vous',
      description: 'Quelques lignes suffisent.',
      type: GOOGLE_ITEM_TYPES.PARAGRAPH,
    }),
    googleItem({
      id: 873269195,
      label: 'Embarquement ?',
      type: GOOGLE_ITEM_TYPES.RADIO,
      options: [googleOption('Retour au QG'), googleOption('Escadrille'), googleOption('Vol')],
    }),
    googleItem({
      id: 1139975474,
      label: 'Disponibilités',
      type: GOOGLE_ITEM_TYPES.CHECKBOX,
      options: [googleOption('Matin'), googleOption('Après-midi'), googleOption('Autre', true)],
    }),
    googleItem({ id: 555000111, label: 'Date de disponibilité', type: GOOGLE_ITEM_TYPES.DATE }),
    googleItem({ id: 555000222, label: 'Notez votre expérience', type: GOOGLE_ITEM_TYPES.STAR }),
  ],
} = {}) {
  const payload = [null, [
    description,
    items,
    null, null, null,
    [null, 0],
    null, null,
    title,
    52,
    [null, null, null, 2, null, null, 1],
  ]];
  // `<` est échappé comme Google le fait, pour que la page reste valide.
  const json = JSON.stringify(payload).replace(/</g, '\\u003c');
  return `<!doctype html><html><body><script nonce="hrdS3aub">var FB_PUBLIC_LOAD_DATA_ =${json};</script></body></html>`;
}

/** Ancien format, objet à clés numériques, encore toléré par le parseur. */
export function legacyGoogleFormHtml({ title = 'Ancien format', description = 'Description legacy', labels, items } = {}) {
  const questions = items ?? labels.map((label, index) => ({
    1: [[[label]], [['']], [['']]],
    3: GOOGLE_ITEM_TYPES.SHORT,
  }));
  const payload = [null, [{
    formInfo: { formDescription: [[title], [description]] },
    1: questions,
  }]];
  const json = JSON.stringify(payload).replace(/</g, '\\u003c');
  return `<!doctype html><html><body><script>var FB_PUBLIC_LOAD_DATA_ =${json};</script></body></html>`;
}

/** `fetchFn` qui répond à la page Google et renvoie `html` pour tout le reste. */
export function googlePageFetch(html, { status = 200 } = {}) {
  return async () => ({
    ok: status >= 200 && status < 300,
    status,
    text: async () => html,
    json: async () => ({}),
  });
}
