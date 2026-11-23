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
| `WEB_FORMS_ROLE_ID` | Rôle de gestion des candidatures et des réponses |
| `WEB_FORMS_ADMIN_ROLE_IDS` | Rôles d'administration transverse des formulaires et des réponses ; les administrateurs complets y sont toujours inclus |
| `WEB_FULL_ADMIN_ROLE_IDS` | Rôles d'administration complète : sanctions, supervision, formulaires, réponses et administration du bot |
| `WEB_BOT_ADMIN_ROLE_ID` | Rôle historique de l'onglet Administration du bot (les administrateurs complets l'obtiennent aussi) |
| `WEB_FORMS_PUBLISH_COOLDOWN_MINUTES` | Délai minimum entre deux publications d'un même créateur |
| `ROBLOX_GROUP_ID` | Groupe Roblox cible des demandes de rank (facultatif) |
| `ROBLOX_OPEN_CLOUD_API_KEY` | Clé Open Cloud limitée à `group:read` et `group:write` pour ce groupe (facultatif, secret) |
| `ROBLOX_REQUESTABLE_ROLE_IDS` | Liste séparée par virgules des identifiants de rôles Roblox autorisés (facultatif, aucun rôle n'est autorisé par défaut) |
| `DOCUMENTATION_ETHICS_URL` | Lien public de la carte « Charte éthique » de `/documentation` |
| `DOCUMENTATION_FACILITY_URL` | Lien public de la carte « Charte de l'installation » de `/documentation` |
| `DISCORD_URL` | Invitation Discord, utilisée par la carte Discord de `/documentation` et par le footer |
| `WEB_MEMBER_MANAGEMENT_ROLE_ID` | Rôle de l'onglet Supervision (`/members`) : annuaire, Deaths, sanctions des autres fiches |
| `MYSQL_*` | Identifiants de connexion MySQL du pool principal (host, port, user, password, database) |
| `SITE_MYSQL_*` | Base du site (miroir `roblox_links`). Facultatif : sans elle, les membres apparaissent non liés |
| `PERMADEATH_WEBHOOK_SECRET` | Secret HMAC du webhook Deaths |

`SESSION_SECRET` n'a **pas** de valeur par défaut : sans elle, les cookies de session seraient signables par n'importe qui. Générer avec :

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

`DISCORD_REDIRECT_URI` doit correspondre exactement à l'URI déclarée dans le portail OAuth2 de l'application Discord, sinon la connexion échoue sur `invalid_request`.

La page `/documentation` est publique : elle ne lit rien en base et se contente de ses trois liens, définis par `DOCUMENTATION_ETHICS_URL`, `DOCUMENTATION_FACILITY_URL` et `DISCORD_URL`. Ces URL sont publiques et se configurent donc directement comme variables d'environnement sur Railway. Sans valeur, les cartes de documentation retombent sur `/` et la carte Discord est rendue désactivée.

## Rôles

Trois rôles de base restent indépendants :

- `WEB_TARGET_ROLE_ID` : lecture du dossier de sanctions sur **sa propre** fiche profil.
- `WEB_FORMS_ROLE_ID` : création et gestion des formulaires, traitement des réponses.
- `WEB_MEMBER_MANAGEMENT_ROLE_ID` : onglet Supervision (`/members`) — annuaire des membres, historique Deaths et sanctions des autres fiches.

Les rôles de `WEB_FULL_ADMIN_ROLE_IDS` héritent de **toutes** ces capacités, ainsi que de l'administration transverse des formulaires (`WEB_FORMS_ADMIN_ROLE_IDS`) et du journal du bot (`/administration/bot`). L'identifiant historique `1518410191933014057` et le nouvel identifiant `1567269299989774356` sont toujours administrateurs complets, même si la variable d'environnement est partielle.

### Demandes de rank Roblox

Le champ de rank reste facultatif. Il n'est proposé qu'avec une liaison Roblox
vérifiée, une configuration Open Cloud complète et des rôles autorisés qui
existent encore dans le groupe. La demande est enregistrée avec les réponses,
mais n'applique aucun changement à la soumission. Seule l'acceptation d'une
candidature par un utilisateur ayant déjà accès à « Réponses » tente
l'attribution; le site revalide le rôle, le compte Roblox lié et l'adhésion au
groupe. Roblox applique également sa propre hiérarchie de rôles.

Pour l'activer :

1. Renseigner `ROBLOX_GROUP_ID` avec l'identifiant du groupe.
2. Créer une clé Open Cloud autorisée uniquement pour ce groupe, avec les
   permissions minimales `group:read` et `group:write`. Conserver la clé dans
   l'environnement de déploiement sous `ROBLOX_OPEN_CLOUD_API_KEY`; ne jamais
   l'ajouter au dépôt.
3. Récupérer les identifiants réels depuis
   `GET https://apis.roblox.com/cloud/v2/groups/{group_id}/roles`, puis définir
   `ROBLOX_REQUESTABLE_ROLE_IDS` avec les identifiants que l'équipe peut
   effectivement attribuer. Ne pas inclure les rôles privilégiés ou le rôle
   propriétaire.
4. Configurer `SITE_MYSQL_*` afin que le site puisse vérifier la liaison
   répliquée par le bot, puis redémarrer le service.

Une clé absente, des permissions insuffisantes, une liaison manquante ou un
échec Roblox n'accordent aucun rôle; le site journalise l'échec sans afficher
ni enregistrer la clé. Une candidature sans rank demandé suit le flux actuel.

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
