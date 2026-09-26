# French Squadron Web

Companion web pour **French Squadron Utilities** : connexion OAuth2, consultation de son profil et du compte Roblox lié, annuaire des membres, gestion des candidatures, traitement des réponses et documentation.

Ce dépôt est autonome. Il partage la base MySQL et l'identité Discord avec le bot, mais n'importe rien du dépôt `French-Squadron-Utilities` : le bot ne dépend pas du site et le site ne dépend pas du bot.

## Prérequis

- Node.js 18+ (avec support natif de `fetch` et `node:test`)
- Base de données MySQL configurée (celle du bot)
- Application Discord (OAuth2) avec l'URI de redirection configurée

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
| `DISCORD_TOKEN` | Token Bot Discord (pour requêter l'API Discord v10 et les rôles) |
| `DISCORD_REDIRECT_URI` | URL de callback OAuth2 (ex: `http://localhost:3000/auth/discord/callback`) |
| `SESSION_SECRET` | Chaîne aléatoire sécurisée pour chiffrer les cookies de session (**obligatoire**) |
| `WEB_PORT` | Port d'écoute du serveur Web (défaut : `3000`) |
| `DISCORD_GUILD_ID` | ID du serveur Discord (défaut : French Squadron) |
| `WEB_TARGET_ROLE_ID` | Rôle donnant accès au panneau de sanctions sur une fiche profil |
| `WEB_FORMS_ROLE_ID` | Rôle de gestion des candidatures, réponses et documentation |
| `WEB_FORMS_PUBLISH_COOLDOWN_MINUTES` | Délai minimum entre deux publications d'un même créateur |
| `MYSQL_*` | Identifiants de connexion MySQL (host, port, user, password, database) |

`SESSION_SECRET` n'a **pas** de valeur par défaut : sans elle, les cookies de session seraient signables par n'importe qui. Générer avec :

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

`DISCORD_REDIRECT_URI` doit correspondre exactement à l'URI déclarée dans le portail OAuth2 de l'application Discord, sinon la connexion échoue sur `invalid_request`.

## Rôles

Deux rôles totalement indépendants, sans hiérarchie entre eux :

- `WEB_TARGET_ROLE_ID` : lecture du dossier de sanctions sur une fiche profil.
- `WEB_FORMS_ROLE_ID` : création et gestion des formulaires, traitement des réponses, documentation.

## Démarrage

```bash
npm start
```

Le serveur web sera accessible par défaut sur `http://localhost:3000`.

## Thème

Le thème sombre est appliqué par défaut, avec un script anti-flash dans le `<head>` pour éviter tout clignotement au chargement. Le bouton dans l'en-tête bascule en thème clair et le choix est conservé dans `localStorage` (`site66-theme`).

## Tests

```bash
npm test
```

Les tests HTTP tournent contre un pool MySQL simulé (`tests/helpers/fake-mysql.js`) et un `fetch` simulé : ni réseau ni base de données ne sont nécessaires. Les variables d'environnement nécessaires sont définies par `tests/helpers/env.js`, donc la suite passe sans `.env`.
