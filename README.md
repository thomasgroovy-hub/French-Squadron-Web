# French Squadron Web

Companion web pour **French Squadron Utilities**, permettant aux membres et officiers de consulter leurs profils, leur compte Roblox lié, leur statut de présence en jeu, et les antécédents disciplinaires (sanctions/strikes/cases).

## Prérequis

- Node.js 18+ (avec support natif de `fetch` et `node:test`)
- Base de données MySQL configurée
- Application Discord (OAuth2) avec Redirection Callback configurée

## Installation

```bash
npm install
```

## Configuration

Copiez `.env.example` vers `.env` et complétez les informations requises :

```bash
cp .env.example .env
```

| Variable | Description |
|---|---|
| `DISCORD_CLIENT_ID` | Identifiant client de l'application Discord OAuth2 |
| `DISCORD_CLIENT_SECRET` | Secret client OAuth2 de l'application Discord |
| `DISCORD_TOKEN` | Token Bot Discord (pour requêter l'API Discord v10 et rôles guild) |
| `DISCORD_REDIRECT_URI` | URL de callback OAuth2 (ex: `http://localhost:3000/auth/discord/callback`) |
| `SESSION_SECRET` | Chaîne aléatoire sécurisée pour chiffrer/signer les cookies de session |
| `WEB_PORT` | Port d'écoute du serveur Web (défaut : `3000`) |
| `DISCORD_GUILD_ID` | ID du serveur Discord (défaut : French Squadron) |
| `WEB_TARGET_ROLE_ID` | Rôle Discord contrôlé / mis en avant sur le profil |
| `MYSQL_*` | Identifiants de connexion MySQL (host, port, user, password, database) |

## Démarrage

```bash
npm start
```

Le serveur web sera accessible par défaut sur `http://localhost:3000`.

## Tests

Pour exécuter la suite de tests automatisée :

```bash
npm test
```
