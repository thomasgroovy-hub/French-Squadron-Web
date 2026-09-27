/**
 * Fixture de la charge utile `FB_PUBLIC_LOAD_DATA_` publiée par un Google Form
 * public. Partagée par les tests du parseur et les tests de la route.
 *
 * Les index correspondent à ce que la page publie réellement, d'où l'imbrication
 * `[[texte]]` sur les libellés.
 */
export function googleFormHtml({
  title = 'Recrutement Pilote',
  description = 'Rejoignez l’escadre.',
  items = [
    { 1: [[['Quel est votre pseudo ?']], [['Votre identifiant en jeu.']], [['Réponse courte']]], 3: 0 },
    { 1: [[['Présentez-vous']], [['']], [['Quelques lignes suffisent.']]], 3: 1 },
    { 1: [[['Embarquement ?']], [['']], [['']]], 3: 3, 4: [['Retour au QG'], ['Escadrille'], ['Vol']] },
    { 1: [[['Disponibilités']], [['']], [['']]], 3: 4, 4: [['Matin'], ['Après-midi'], ['Nuit']] },
    { 1: [[['Date de disponibilité']], [['']], [['']]], 3: 5 },
    { 1: [[['Notez votre expérience']], [['']], [['']]], 3: 7 },
  ],
} = {}) {
  const loadData = [
    null,
    {
      1: items,
      3: { formInfo: { formDescription: [[title], [description]] } },
    },
  ];
  // `<` est échappé comme Google le fait, pour que la page reste valide.
  const payload = JSON.stringify(loadData).replace(/</g, '\\u003c');
  return `<!doctype html><html><body><script>var FB_PUBLIC_LOAD_DATA_ =${payload};</script></body></html>`;
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
