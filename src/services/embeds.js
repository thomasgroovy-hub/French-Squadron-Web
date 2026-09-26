/**
 * Accent unique du bot, réutilisé par les messages directs envoyés depuis le
 * portail. Doit rester synchronisé avec `BOT_ACCENT_COLOR` de src/components.js
 * dans French-Squadron-Utilities, afin que le DM envoyé par le site et celui
 * envoyé par le bot aient la même couleur.
 */
export const BOT_ACCENT_COLOR = 0x475569;

/**
 * Embed envoyé en message direct au candidat dont la candidature vient d'être
 * acceptée depuis l'onglet « Réponses ».
 *
 * Construit un objet brut plutôt qu'un `EmbedBuilder` : le portail n'a pas
 * besoin de discord.js, et `sendDirectMessage` accepte les deux formes.
 */
export function createApplicationAcceptedEmbed({
  formTitle = null,
  applicantName = null,
  grantedRoleName = null,
  timestamp = new Date(),
} = {}) {
  const fields = [];
  if (formTitle) fields.push({ name: 'Formulaire', value: formTitle, inline: false });
  if (grantedRoleName) fields.push({ name: 'Rôle attribué', value: grantedRoleName, inline: false });
  if (applicantName) fields.push({ name: 'Candidat', value: applicantName, inline: false });

  return {
    title: 'Candidature acceptée',
    description: 'Tu as été accepté !',
    color: BOT_ACCENT_COLOR,
    footer: { text: 'FPCS Utilities' },
    timestamp: timestamp.toISOString(),
    ...(fields.length ? { fields } : {}),
  };
}
