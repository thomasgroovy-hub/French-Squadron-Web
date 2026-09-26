import 'dotenv/config';

export const webConfig = {
  clientId: process.env.DISCORD_CLIENT_ID || process.env.DISCORD_APPLICATION_ID,
  clientSecret: process.env.DISCORD_CLIENT_SECRET,
  redirectUri: process.env.DISCORD_REDIRECT_URI || `http://localhost:${process.env.WEB_PORT || process.env.PORT || 3000}/auth/discord/callback`,
  discordToken: process.env.DISCORD_TOKEN,
  guildId: process.env.DISCORD_GUILD_ID || '1487258655840669807',
  targetRoleId: process.env.WEB_TARGET_ROLE_ID || '1553099793532854382',
  sessionSecret: process.env.SESSION_SECRET || 'fpcs-utilities-secret-cookie-key',
  cookieName: 'fpcs_session',
  port: Number.parseInt(process.env.WEB_PORT || process.env.PORT || 3000, 10),
  isProduction: process.env.NODE_ENV === 'production',
};

export function validateWebConfig() {
  const missing = [];
  if (!webConfig.clientId) missing.push('DISCORD_APPLICATION_ID / DISCORD_CLIENT_ID');
  if (!webConfig.clientSecret) missing.push('DISCORD_CLIENT_SECRET');
  if (!webConfig.discordToken) missing.push('DISCORD_TOKEN');
  return {
    valid: missing.length === 0,
    missing,
  };
}
