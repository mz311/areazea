# Connecter votre serveur Discord

## 1. Créer l'application

1. <https://discord.com/developers/applications> → **New Application** (nom = nom de votre communauté).
2. **OAuth2 → General** :
   * copiez **Client ID** → `DISCORD_CLIENT_ID` ;
   * **Reset Secret** puis copiez-le → `DISCORD_CLIENT_SECRET` (secret : jamais dans le code ni côté navigateur) ;
   * **Redirects → Add Redirect** : `https://VOTRE-SITE/api/auth/discord/callback` (en local : `http://localhost:3000/api/auth/discord/callback`). L'URL doit être **identique** à `APP_URL` + `/api/auth/discord/callback`.
3. Scopes demandés par le site : `identify` et `guilds.members.read` (lecture de **vos propres** rôles dans **ce** serveur ; rien d'autre).

## 2. Identifiants du serveur

Activez le **mode développeur** (Paramètres Discord → Avancés), puis clic droit :

| Valeur | Où la trouver | Variable |
|---|---|---|
| ID du serveur | clic droit sur l'icône du serveur → *Copier l'identifiant* | `DISCORD_GUILD_ID` |
| ID de votre compte | clic droit sur votre profil → *Copier l'identifiant* | `ADMIN_DISCORD_IDS` (administrateur permanent) |
| ID des rôles | Paramètres du serveur → Rôles → clic droit sur le rôle | voir ci-dessous |

## 3. Rôles → permissions

| Permission du site | Variable (IDs de rôles Discord, séparés par des virgules) | Accès |
|---|---|---|
| Membre | `DISCORD_ROLE_MEMBER_IDS` *(optionnel)* | Versions stables « membre ». Si renseigné, **requis** pour télécharger (ex. rôle « Vérifié »). Vide = tout membre du serveur. |
| VIP | `DISCORD_ROLE_VIP_IDS` | + versions réservées VIP |
| Développeur | `DISCORD_ROLE_DEVELOPER_IDS` | + canal **bêta** |
| Administrateur | `DISCORD_ROLE_ADMIN_IDS` | + panel d'administration |

Le plus haut rôle gagne. Un administrateur peut aussi **surcharger** le rôle d'un utilisateur (Admin → Utilisateurs) ou le **bannir** (sessions et jetons launcher révoqués immédiatement). Un utilisateur qui n'est pas dans le serveur n'a **aucun** accès aux téléchargements.

Les rôles sont relus **à chaque connexion**. Pour qu'un retrait de rôle (ou un départ du serveur) soit pris en compte **sans reconnexion** (au plus 10 minutes), ajoutez un **bot** :

1. Onglet **Bot** → *Reset Token* → `DISCORD_BOT_TOKEN`.
2. OAuth2 → URL Generator → scope `bot`, aucune permission → invitez le bot sur votre serveur.

## 4. Webhooks (annonces)

Paramètres du salon → **Intégrations → Webhooks → Nouveau webhook → Copier l'URL**.

| Variable | Usage |
|---|---|
| `DISCORD_WEBHOOK_URL` | Mises à jour publiées et annonces (embed : version, nouveautés, **bouton vers le site**) |
| `DISCORD_MAINTENANCE_WEBHOOK_URL` | Début / fin de maintenance (sinon le webhook principal) |
| `DISCORD_PRIVATE_WEBHOOK_URL` | Salon **staff** : versions réservées VIP / dev / bêta (jamais annoncées publiquement) |
| `DISCORD_NOTIFY_ROLE_ID` | Rôle mentionné pour les mises à jour publiques et les « nouvelles ressources » |

Sécurité : les URL de webhook ne sont **jamais** exposées au navigateur ni modifiables depuis le site ; l'application refuse tout hôte autre que `discord.com` ; seul le rôle configuré peut être mentionné (`allowed_mentions` restreint : pas de `@everyone`, pas de mention d'utilisateurs).

## 5. Tester

1. Connectez-vous sur le site : vous devez voir votre avatar et votre rôle (page *Mon compte*).
2. Admin → Annonces → cochez « Envoyer aussi sur Discord » : le message doit apparaître dans le salon.
3. Depuis un compte sans le rôle requis : le bouton de téléchargement est absent et l'API répond `403 role_required`.
