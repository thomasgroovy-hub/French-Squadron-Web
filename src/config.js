import 'dotenv/config';

if (!process.env.SESSION_SECRET) {
  throw new Error('SESSION_SECRET is required. Generate with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"');
}

/**
 * Rôles d'administration des formulaires : accès à *tous* les formulaires et à
 * *toutes* les réponses, sans restriction d'auteur.
 *
 * Ils sont volontairement distincts de `formsRoleId`, qui reste le rôle de
 * gestion « sur ses propres formulaires ». Un membre portant l'un de ces rôles
 * n'est pas forcément recruteur : il supervise. La liste est lisible depuis
 * `WEB_FORMS_ADMIN_ROLE_IDS` (séparateurs virgule ou espace) pour pouvoir la
 * faire évoluer sans redéploiement ; les valeurs par défaut sont les deux rôles
 * historiques.
 */
const DEFAULT_FORMS_ADMIN_ROLE_IDS = Object.freeze([
  '1518411282909368420',
  '1518410191933014057',
]);

/**
 * Administrateurs complets : ils héritent de toutes les capacités réservées
 * (sanctions, supervision, formulaires, réponses et administration du bot).
 * L'identifiant historique reste toujours inclus pour ne jamais perdre ses
 * droits, même si la variable d'environnement est partielle.
 */
const DEFAULT_FULL_ADMIN_ROLE_IDS = Object.freeze([
  '1518410191933014057',
  '1567269299989774356',
]);

function parseRoleIdList(raw, fallback) {
  const entries = (typeof raw === 'string' ? raw : '')
    .split(/[\s,]+/)
    .map((entry) => entry.trim())
    // Un snowflake Discord fait 17 à 20 chiffres : filtrer ici évite qu'un
    // reste de configuration ne soit silencieusement traité comme un rôle.
    .filter((entry) => /^\d{17,20}$/.test(entry));
  const unique = [...new Set(entries)];
  return Object.freeze(unique.length ? unique : fallback);
}

function uniqueRoleIds(...lists) {
  return Object.freeze([...new Set(lists.flat().filter(Boolean))]);
}

const fullAdminRoleIds = uniqueRoleIds(
  parseRoleIdList(process.env.WEB_FULL_ADMIN_ROLE_IDS, DEFAULT_FULL_ADMIN_ROLE_IDS),
  DEFAULT_FULL_ADMIN_ROLE_IDS,
);

const targetRoleId = process.env.WEB_TARGET_ROLE_ID || '1553099793532854382';
const memberManagementRoleId = process.env.WEB_MEMBER_MANAGEMENT_ROLE_ID || '1487266203864006707';
const botAdminRoleId = process.env.WEB_BOT_ADMIN_ROLE_ID || '1518410191933014057';

const configuredFormsAdminRoleIds = parseRoleIdList(
  process.env.WEB_FORMS_ADMIN_ROLE_IDS,
  DEFAULT_FORMS_ADMIN_ROLE_IDS,
);
const configuredBotAdminRoleIds = parseRoleIdList(
  process.env.WEB_BOT_ADMIN_ROLE_IDS,
  [botAdminRoleId],
);

function parseRobloxRoleIdList(raw) {
  const entries = (typeof raw === 'string' ? raw : '')
    .split(/[\s,]+/)
    .map((entry) => entry.trim())
    .filter(Boolean);
  return Object.freeze([...new Set(entries)]);
}

/**
 * Seules les URL http(s) absolues atteignent une vue : `javascript:` ou `data:`
 * finiraient dans un href, et une valeur tronquée casserait le lien au lieu de
 * retomber sur le repli. Ces trois liens sont de la configuration publique
 * (Railway), pas des secrets, mais le filtre ne coûte rien.
 */
function publicUrl(value, fallback = '') {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!raw) return fallback;
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return fallback;
    return parsed.toString();
  } catch {
    return fallback;
  }
}

export const webConfig = {
  clientId: process.env.DISCORD_CLIENT_ID || process.env.DISCORD_APPLICATION_ID,
  clientSecret: process.env.DISCORD_CLIENT_SECRET,
  redirectUri: process.env.DISCORD_REDIRECT_URI || `http://localhost:${process.env.WEB_PORT || process.env.PORT || 3000}/auth/discord/callback`,
  discordToken: process.env.DISCORD_TOKEN,
  guildId: process.env.DISCORD_GUILD_ID || '1487258655840669807',
  // Rôles d'administration complète et leurs capacités dérivées. Les rôles
  // historiques restent dans chaque liste : aucun droit existant n'est retiré.
  fullAdminRoleIds,
  // Rôle donnant accès au panneau de sanctions sur la fiche profil.
  targetRoleId,
  targetRoleIds: uniqueRoleIds([targetRoleId], fullAdminRoleIds),
  // Rôle de gestion des candidatures et des réponses. Totalement
  // indépendant de `targetRoleId` : ni parent, ni enfant, ni substitution.
  formsRoleId: process.env.WEB_FORMS_ROLE_ID || '1532037579816570981',
  // Rôles d'administration des formulaires : accès transverse à tous les
  // formulaires et à toutes les réponses. Orthogonal à `formsRoleId`, qui reste
  // cantonné aux formulaires créés par son porteur.
  formsAdminRoleIds: uniqueRoleIds(configuredFormsAdminRoleIds, fullAdminRoleIds),
  robloxGroupId: process.env.ROBLOX_GROUP_ID?.trim() || null,
  robloxOpenCloudApiKey: process.env.ROBLOX_OPEN_CLOUD_API_KEY?.trim() || null,
  robloxRequestableRoleIds: parseRobloxRoleIdList(process.env.ROBLOX_REQUESTABLE_ROLE_IDS),
  // Rôle pour la gestion des membres (onglet Supervision) - Permadeath, sanctions, etc.
  memberManagementRoleId,
  memberManagementRoleIds: uniqueRoleIds([memberManagementRoleId], fullAdminRoleIds),
  // Rôle d'administration du bot (onglet Administration). Le scalaire est
  // conservé pour compatibilité ; les gardes utilisent la liste.
  botAdminRoleId,
  botAdminRoleIds: uniqueRoleIds(configuredBotAdminRoleIds, fullAdminRoleIds),
  // Liens publics de la page /documentation et du footer, configurables sur
  // Railway. Repli sur « / » pour la documentation : une carte qui renvoie au
  // site vaut mieux qu'une URL cassée.
  documentationEthicsUrl: publicUrl(process.env.DOCUMENTATION_ETHICS_URL, '/'),
  documentationFacilityUrl: publicUrl(process.env.DOCUMENTATION_FACILITY_URL, '/'),
  // Aucun repli plausible pour Discord : sans DISCORD_URL la carte est rendue
  // désactivée, plutôt que de pointer vers une adresse inventée.
  discordUrl: publicUrl(process.env.DISCORD_URL, ''),
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
