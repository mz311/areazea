# FiveM Base Manager

Plateforme complète pour distribuer **votre base FiveM** à votre communauté Discord :

* **Site** (Next.js / React / TypeScript / Tailwind / Framer Motion) — accueil, téléchargement, historique des versions, compte, **panel administrateur**.
* **API** (routes Next.js sur Node, PostgreSQL + Prisma, stockage local ou **S3**) — connexion **Discord OAuth2**, rôles, liens de téléchargement temporaires, manifeste SHA-256, rollback, webhooks Discord.
* **Launcher Windows** (Tauri 2 + moteur Rust) — installation, **mises à jour différentielles**, vérification SHA-256, sauvegarde / restauration automatique, réparation, protection de vos fichiers de configuration.
* **Ressource FiveM `fbm-updater`** — les mêmes mises à jour **directement sur le serveur**, avec la commande `fbm update` dans la console **txAdmin** ou **en jeu**, appliquées au redémarrage.

```
┌─────────────┐  OAuth2   ┌───────────────────────────┐   ┌────────────┐
│  Discord    │◄─────────►│  Site + API (web/)        │◄─►│ PostgreSQL │
└─────▲───────┘ webhooks  │  Next.js · Prisma         │   └────────────┘
      │                   │                           │   ┌────────────┐
      │                   │  admin : upload ZIP →     │◄─►│ Stockage   │
      │                   │  blobs SHA-256 + manifeste│   │ local / S3 │
      │                   └─────────▲─────────────────┘   └────────────┘
      │                             │ HTTPS (jeton launcher, liens signés)
      │                   ┌─────────┴─────────────────┐
      └───────────────────┤ Launcher (launcher/)      │  ← joueurs (Windows)
                          │ Tauri + moteur Rust       │
                          └───────────────────────────┘
```

| Dossier | Contenu |
|---|---|
| [`web/`](web) | Site, API, panel admin, schéma Prisma, tests |
| [`launcher/core`](launcher/core) | Moteur de mise à jour (Rust, sans dépendance UI) + CLI `fbm-cli` + tests |
| [`launcher/src-tauri`](launcher/src-tauri) · [`launcher/ui`](launcher/ui) | Application Tauri (Windows) |
| [`launcher/e2e`](launcher/e2e) | Test bout-en-bout launcher ↔ vrai serveur |
| [`fivem/fbm-updater`](fivem/fbm-updater) | Ressource FiveM : `fbm update` depuis txAdmin / en jeu, SQL automatique ([guide](fivem/fbm-updater/README.md)) |
| [`fivem/test`](fivem/test) · [`fivem/e2e`](fivem/e2e) | Tests de la ressource (harnais FiveM simulé, MariaDB réel) et parcours complet |
| [`deploy/`](deploy) · [`docker-compose.yml`](docker-compose.yml) | nginx, Docker |
| [`docs/`](docs) | [Discord](docs/discord.md) · [Architecture & API](docs/architecture.md) · [Sécurité](docs/security.md) · [Launcher](docs/launcher.md) |

## Démarrage rapide (développement)

Prérequis : **Node 22**, **PostgreSQL 16**, (Rust stable pour le launcher).

```bash
# 1. Base de données
createuser -P fbm            # mot de passe : fbm
createdb -O fbm fbm
createdb -O fbm fbm_test     # uniquement pour les tests e2e

# 2. Site
cd web
cp .env.example .env         # renseigner au minimum APP_SECRET, DISCORD_* et ADMIN_DISCORD_IDS
npm ci
npx prisma migrate deploy
npm run dev                  # http://localhost:3000
```

1. Configurez votre application Discord : **[docs/discord.md](docs/discord.md)** (5 minutes).
2. Mettez **votre ID Discord** dans `ADMIN_DISCORD_IDS` : vous serez administrateur à la première connexion.
3. Connectez-vous, ouvrez **Admin → Versions**, importez le ZIP de votre base, rédigez le changelog, **Publiez**.

> Sans Discord (développement local) : `APP_URL=http://localhost:3000 npm run demo:seed` crée 2 versions de démo et affiche un cookie de session administrateur à coller dans votre navigateur. **Refusé en production.**

### Workflow d'administration

1. **Première version — Versions → Nouvelle version → « Base complète »** : le ZIP de toute votre base. Mettez le SQL de départ (schéma, données) dans un dossier **`_sql/`** du ZIP (ex. `_sql/001_base.sql`).
2. **Mises à jour — « Patch : fichiers modifiés »** : un ZIP avec **uniquement** les fichiers modifiés ou ajoutés, à leur emplacement (`resources/garage/client.lua`…), le SQL de la mise à jour dans **`_sql/`** (ex. `_sql/001_garage.sql`), et les fichiers à supprimer listés dans le formulaire ou dans **`fbm-delete.txt`**. Le site fusionne le patch sur la version de base.
3. Dans les deux cas le site **reconstruit la base complète** : le ZIP téléchargé par les joueurs est prêt à lancer, avec le `server.cfg`, l'historique SQL (`sql/migrations/<version>/`) et **`sql/install.sql`** (toute la base de données à jour, à importer une fois).
4. **Éditer** : titre, résumé, changelog (`NEW` / `FIX` / `IMPROVEMENT`, images). Les **détails techniques** (fichiers ajoutés / modifiés / supprimés, ressources touchées, SQL) sont ajoutés automatiquement aux patch notes.
5. **Publier** (+ embed Discord optionnel) ; **Rollback** pour rétablir une version précédente.

Côté serveurs des joueurs, `fbm update` affiche ces patch notes, **exécute le SQL** pas encore appliqué (via oxmysql, une seule fois par fichier) et installe les fichiers au redémarrage.

## Production

```bash
cp web/.env.example web/.env       # APP_URL en https, secrets, Discord, stockage…
docker compose up -d --build       # PostgreSQL + migrations + site (127.0.0.1:3000)
```

Placez **nginx** (ou Caddy/Traefik) devant, avec HTTPS : voir [`deploy/nginx.conf`](deploy/nginx.conf) (taille d'upload, délais, `X-Real-IP`). Sans Docker : `npm ci && npm run build && npx prisma migrate deploy && node .next/standalone/server.js` (copier `.next/static` dans `.next/standalone/.next/static`).

* **Stockage S3** (R2, MinIO, S3…) : `STORAGE_DRIVER=s3` + `S3_*`. Les fichiers restent **privés** ; les joueurs reçoivent des liens présignés de `DOWNLOAD_URL_TTL_SECONDS` secondes. Si `S3_ENDPOINT` est un nom interne, renseignez `S3_PUBLIC_ENDPOINT`.
* **Sauvegardes** : base PostgreSQL **et** stockage (blobs + archives). Le manifeste d'une version est dans la base ; les fichiers dans le stockage.
* **Nettoyage** : Admin → Tableau de bord → « Nettoyage du stockage » supprime les fichiers qu'aucune version ne référence plus.
* **Plusieurs instances** : la limitation de débit est en mémoire (par instance) — remplacez `src/lib/rate-limit.ts` par Redis si vous répartissez la charge.

## Launcher Windows

```bash
cd launcher
npm ci
FBM_API_URL=https://base.example.com npx tauri build      # → target/release/bundle/nsis/*.exe
```

L'URL du site est **compilée** dans le launcher (https obligatoire en release). Le workflow GitHub [`release-launcher.yml`](.github/workflows/release-launcher.yml) produit l'installateur sur un runner Windows (tag `launcher-v1.0.0`, variable de dépôt `FBM_API_URL`). Déposez ensuite le `.exe` où vous voulez et renseignez son URL dans **Admin → Paramètres**. Détails, garanties de sécurité et CLI : **[docs/launcher.md](docs/launcher.md)**. Pour éviter l'alerte SmartScreen, **signez** l'exécutable (certificat de signature de code).

## Mise à jour depuis txAdmin

Copiez [`fivem/fbm-updater`](fivem/fbm-updater) dans votre base (ex. `resources/[fbm]/fbm-updater`, avec `config.json` → `api`). Chaque joueur crée un jeton sur *Mon compte*, l'ajoute dans son `server.cfg`, tape **`fbm update`** dans la console txAdmin (ou `/fbm update` en jeu) puis **redémarre** : seuls les fichiers modifiés sont téléchargés, le SQL de la mise à jour est exécuté via oxmysql, les fichiers s'appliquent au démarrage, ses configs restent intactes. Guide complet : **[fivem/fbm-updater/README.md](fivem/fbm-updater/README.md)**.

## Tests

```bash
cd web      && npm test              # unitaires (chemins, ZIP malveillants, manifeste, rôles, webhooks, env…)
cd web      && npm run test:e2e      # bout-en-bout : vrai Next.js + PostgreSQL (base fbm_test)
cd web      && E2E_S3=1 npm run test:e2e   # idem avec un serveur S3 (ex. `moto_server -p 5555`, bucket fbm-test)
cd launcher && cargo test -p fbm-core      # moteur de mise à jour
cd launcher && cargo build --release -p fbm-core --bin fbm-cli && python3 e2e/run.py   # launcher ↔ serveur réel
cd fivem/test && npm ci && npm test    # ressource txAdmin : moteur, SQL (MariaDB si disponible), harnais FiveM simulé
python3 fivem/e2e/run.py                # parcours complet : base + patch, ZIP, install.sql, fbm update + SQL (MariaDB), launcher
```

## Ce qui a été vérifié — et ce qui ne l'a pas été

**Exécuté et validé** pendant le développement : tests unitaires, e2e API (stockage local **et** S3 via `moto`), `next build`, build de production *standalone*, moteur du launcher (tests + scénario complet contre un vrai serveur : installation, mise à jour différentielle, rollback, réparation, maintenance, jeton révoqué, reprise après crash), **application Tauri compilée sur Linux et pilotée sous Xvfb** (connexion par boucle locale, installation et rollback par clic, captures d'écran), **ressource `fbm-updater`** (tests sous Node 22 et Node 16, scénario complet contre un vrai serveur, relais avec le launcher Rust dans les deux sens), **patchs et SQL** (fusion, `install.sql` importé dans un vrai MariaDB, exécution automatique du SQL des mises à jour, triggers avec `DELIMITER`).

**Non vérifié ici** (à tester chez vous avant la mise en production) :

* La **connexion Discord réelle** (OAuth2, lecture des rôles, bot) et l'**envoi réel des webhooks** : aucun accès à Discord depuis l'environnement de développement. Le code suit l'API Discord v10 ; les webhooks et les rôles sont couverts par des tests avec Discord simulé.
* Le **`.exe` Windows / l'installateur NSIS** et le Gestionnaire d'informations d'identification Windows (`keyring`) : l'application n'a été compilée et exécutée que sous Linux. Le build Windows passe par le workflow GitHub fourni.
* La ressource **`fbm-updater` dans un vrai FXServer / txAdmin** : les natives FiveM (commande, convars, chat, ordre de démarrage) **et oxmysql** sont simulés dans les tests (le SQL, lui, tourne sur un vrai MariaDB). À valider sur un serveur de test avant vos joueurs, en particulier le fait qu'`ensure fbm-updater` placé en premier s'exécute avant les ressources suivantes.
* **Docker / docker-compose** (pas de démon Docker disponible) — les étapes équivalentes (build standalone + `node server.js`) ont été exécutées.
* Passage à l'échelle (milliers de joueurs simultanés, bases de plusieurs Go) : conçu pour (téléchargements directs depuis S3, blobs dédupliqués, upload en flux) mais non mesuré.

## Licence

À définir par le propriétaire du dépôt.
