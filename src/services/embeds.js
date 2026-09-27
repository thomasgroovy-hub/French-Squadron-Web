import { createV2Message, BOT_ACCENT_COLOR } from './components.js';

export { BOT_ACCENT_COLOR };

/**
 * Message direct envoyé au candidat dont la candidature vient d'être acceptée
 * depuis l'onglet « Réponses ».
 *
 * Construit via `createV2Message` (Components V2) pour que le rendu soit
 * rigoureusement identique à celui des messages envoyés par le bot, et non un
 * embed classique qui aurait un aspect différent.
 */
export function createApplicationAcceptedPayload({
  formTitle = null,
  applicantName = null,
  grantedRoleName = null,
} = {}) {
  const sections = [];
  if (formTitle) sections.push(`**Formulaire**\n${formTitle}`);
  if (grantedRoleName) sections.push(`**Rôle attribué**\n${grantedRoleName}`);
  if (applicantName) sections.push(`**Candidat**\n${applicantName}`);

  return createV2Message({
    title: 'Candidature acceptée',
    description: 'Tu as été accepté !',
    sections,
    footer: 'FPCS Utilities',
    accentColor: BOT_ACCENT_COLOR,
  });
}
