/**
 * Variables d'environnement pour la suite de tests.
 *
 * Doit être importé AVANT `../src/config.js` dans chaque test : la config est
 * évaluée au chargement du module et lit `process.env` une seule fois. Sans
 * ceci, les tests ne passeraient que si la machine du développeur possède un
 * `.env` avec un SESSION_SECRET défini.
 */
process.env.SESSION_SECRET ||= 'test-session-secret-not-a-real-credential';
process.env.DISCORD_APPLICATION_ID ||= '123456789012345678';
process.env.DISCORD_CLIENT_ID ||= '123456789012345678';
process.env.DISCORD_CLIENT_SECRET ||= 'test-client-secret';
process.env.DISCORD_TOKEN ||= 'test-bot-token';
// Liens publics de /documentation. Faux domaines et fausse invitation : la page
// n'a besoin que de la forme d'une URL http(s), jamais d'une vraie destination.
process.env.DOCUMENTATION_ETHICS_URL ||= 'https://docs.example.test/charte-ethique';
process.env.DOCUMENTATION_FACILITY_URL ||= 'https://docs.example.test/charte-installation';
process.env.DISCORD_URL ||= 'https://discord.gg/test-invitation';
