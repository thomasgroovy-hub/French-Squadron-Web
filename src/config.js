import 'dotenv/config';

if (!process.env.SESSION_SECRET) {
  throw new Error('SESSION_SECRET is required. Generate with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"');
}

export const webConfig = {
  clientId: process.env.DISCORD_CLIENT_ID || process.env.DISCORD_APPLICATION_ID,
  clientSecret: process.env.DISCORD_CLIENT_SECRET,
  redirectUri: process.env.DISCORD_REDIRECT_URI || `http://localhost:${process.env.WEB_PORT || process.env.PORT || 3000}/auth/discord/callback`,
  discordToken: process.env.DISCORD_TOKEN,
  guildId: process.env.DISCORD_GUILD_ID || '1487258655840669807',
  // Rôle donnant accès au panneau de sanctions sur la fiche profil.
  targetRoleId: process.env.WEB_TARGET_ROLE_ID || '1553099793532854382',
  // Rôle de gestion des candidatures et de la documentation. Totalement
  // indépendant de `targetRoleId` : ni parent, ni enfant, ni substitution.
  formsRoleId: process.env.WEB_FORMS_ROLE_ID || '1532037579816570981',
  // Rôle pour la gestion des membres (onglet Supervision) - Permadeath, sanctions, etc.
  memberManagementRoleId: process.env.WEB_MEMBER_MANAGEMENT_ROLE_ID || '1487266203864006707',
  // Délai minimum entre deux publications de formulaire par un même créateur.
  formsPublishCooldownMinutes: Number.parseInt(process.env.WEB_FORMS_PUBLISH_COOLDOWN_MINUTES || '30', 10),
  // Pas de valeur de repli : en production, une clé de session/devise absente
  // rendrait les cookies de session signables par n'importe qui.
  sessionSecret: process.env.SESSION_SECRET,
  cookieName: 'fpcs_session',
  port: Number.parseInt(process.env.WEB_PORT || process.env.PORT || 3000, 10),
  isProduction: process.env.NODE_ENV === 'production',
};

export function validateWebConfig() {
  const missing = [];
  if (!webConfig.clientId) missing.push('DISCORD_APPLICATION_ID / DISCORD_CLIENT_ID');
  if (!webConfig.clientSecret) missing.push('DISCORD_CLIENT_SECRET');
  if (!webConfig.discordToken) missing.push('DISCORD_TOKEN');
  if (!webConfig.sessionSecret) missing.push('SESSION_SECRET');
  return {
    valid: missing.length === 0,
    missing,
  };
}
