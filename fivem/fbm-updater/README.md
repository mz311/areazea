# fbm-updater — mises à jour de la base depuis txAdmin

Ressource FiveM qui met à jour **votre base** directement sur le serveur, avec une commande dans la **console txAdmin** ou **en jeu**. Elle utilise le même site, les mêmes rôles Discord et les mêmes règles que le launcher.

## Installation (une seule fois)

1. **Jeton** : sur le site, page **Mon compte → Créer un jeton**. Copiez-le, il ne sera plus affiché.
2. **server.cfg**, avant vos autres `ensure` :
   ```cfg
   set fbm_api "https://votre-site.tld"
   set fbm_token "fvl_…"
   ensure fbm-updater
   ```
   `fbm-updater` doit démarrer **en premier** : c'est lui qui applique la mise à jour au démarrage, avant que les autres ressources ne se chargent.
3. **En jeu** (optionnel) : la commande demande la permission `command.fbm`.
   ```cfg
   add_ace group.admin command.fbm allow
   ```
   La console du serveur / txAdmin y a toujours accès.

> Utilisez `set` (jamais `setr` ni `sets`) : le jeton ne doit pas être envoyé aux joueurs.

## Utilisation

| Commande (console txAdmin) | En jeu | Effet |
|---|---|---|
| `fbm status` | `/fbm status` | Version installée, version disponible, **patch notes**, fichiers et SQL qui changeront |
| `fbm update` | `/fbm update` | Télécharge **uniquement les fichiers modifiés** (vérifiés SHA-256), **exécute le SQL** de la mise à jour, fichiers appliqués au redémarrage |
| `fbm update 1.2.0` | `/fbm update 1.2.0` | Prépare une version précise (ex. revenir en arrière) |
| `fbm repair` | `/fbm repair` | Re-vérifie tous les fichiers et prépare la réparation de ceux qui sont abîmés |
| `fbm cancel` | `/fbm cancel` | Annule une mise à jour préparée (le SQL déjà exécuté reste) |
| `fbm sql` | `/fbm sql` | État du SQL : fichiers appliqués / en attente (registre `fbm_migrations`) |
| `fbm sql baseline` | `/fbm sql baseline` | Base de données existante : marque le SQL de la version installée comme déjà appliqué |
| `fbm sql run` | `/fbm sql run` | Exécute le SQL manquant de la version installée |

Puis **redémarrez le serveur** (txAdmin → *Restart*) : la mise à jour est appliquée au démarrage et le résultat s'affiche dans la console :

```
[fbm] ✔ Mise à jour appliquée : v1.0.0 → v1.1.0 (2 fichier(s) écrit(s), 1 supprimé(s), 2 config(s) protégée(s) conservée(s)).
```

La ressource vérifie aussi toutes les heures si une nouvelle version existe et prévient la console et les admins connectés.

## SQL automatique

Chaque version peut contenir du SQL (mis par l'admin dans `_sql/`). `fbm update` :

1. lit le registre **`fbm_migrations`** de votre base de données (créé par `sql/install.sql` ou par la ressource) ;
2. exécute via **oxmysql**, dans l'ordre, les fichiers SQL qui n'y sont pas encore — **une seule fois par fichier** ;
3. n'installe les nouveaux fichiers (au redémarrage) **que si le SQL a réussi** : le nouveau code ne démarre jamais sans sa base de données.

| Situation | Comportement |
|---|---|
| Installation depuis le ZIP du site + `sql/install.sql` importé | Registre déjà rempli : seules les mises à jour suivantes s'exécutent |
| Base de données **vide** (aucune table) | Tout l'historique SQL est exécuté |
| Base **existante sans registre** (serveur installé avant fbm) | Rien n'est exécuté : `fbm sql baseline` (si la base correspond à votre version), puis `fbm update` |
| Erreur SQL | Message avec le fichier, l'instruction et l'erreur ; mise à jour des fichiers annulée |
| Retour à une version antérieure | Fichiers restaurés ; le SQL des versions plus récentes **n'est pas annulé** (écrivez des changements SQL compatibles : ajouts de tables / colonnes) |

Le SQL s'exécute pendant que le serveur tourne (avant le redémarrage) : privilégiez des changements **additifs** (`CREATE TABLE IF NOT EXISTS`, `ADD COLUMN … DEFAULT …`). oxmysql doit être démarré ; pour gérer le SQL vous-même : `set fbm_sql off` (la commande indique alors les fichiers à importer).

## Pourquoi « préparer puis redémarrer » ?

Remplacer les fichiers d'une ressource **pendant** qu'elle tourne ne la recharge pas, et Windows peut refuser d'écraser un fichier en cours d'utilisation. Le téléchargement (la partie longue) se fait donc serveur allumé ; l'écriture, quasi instantanée, se fait au redémarrage, avant le chargement des autres ressources.

## Garanties

* **Téléchargement minimal**, vérifié en taille et SHA-256, liens temporaires renouvelés s'ils expirent.
* **Rien n'est modifié** avant le redémarrage ; `fbm cancel` annule.
* **Transaction** : les fichiers remplacés sont sauvegardés ; en cas d'erreur (fichier verrouillé, disque plein, coupure), tout est **restauré** et la mise à jour est retentée au redémarrage suivant.
* **Configs protégées** : `server.cfg`, `**/config.lua`, `**/config.json`, `txData/**`… ne sont jamais écrasés ni supprimés. Motifs supplémentaires : `set fbm_protect "resources/mon-script/**;**/mes-reglages.lua"`.
* **Suppressions limitées** aux fichiers installés par l'outil, dans les dossiers gérés de la base ; vos propres ressources ne sont jamais touchées.
* **Même format que le launcher** (`.fbm/state.json`, aussi inclus dans le ZIP du site) : installez avec le ZIP, le launcher ou `fbm-cli`, puis mettez à jour avec la ressource, et inversement.
* **Accès** selon le rôle Discord du compte qui a créé le jeton ; un jeton révoqué ou un compte banni est refusé immédiatement.

## Réglages (convars)

| Convar | Défaut | Rôle |
|---|---|---|
| `fbm_api` | `config.json` → `api` | URL du site |
| `fbm_token` | — | Jeton (Mon compte) |
| `fbm_channel` | `STABLE` | `BETA` pour les développeurs |
| `fbm_dir` | dossier parent de `resources/` | Racine de la base |
| `fbm_protect` | — | Motifs protégés supplémentaires (séparés par `;`) |
| `fbm_check_interval` | `60` | Minutes entre deux vérifications (`0` = jamais) |
| `fbm_sql` | `auto` | `off` : le SQL des mises à jour n'est pas exécuté automatiquement |

**Astuce pour l'administrateur de la base** : placez `fbm-updater` dans votre base (ex. `resources/[fbm]/fbm-updater`) avec `config.json` → `"api": "https://votre-site.tld"`. Chaque joueur le reçoit, n'a plus qu'à ajouter son jeton, et la ressource se met à jour avec le reste de la base.

## Compatibilité

Node 22 (`node_version '22'`, artifacts récents) et Node 16 (artifacts plus anciens). Aucune dépendance npm.

## Tests

Les tests sont dans [`fivem/test`](../test) (hors de la ressource : rien à copier sur votre serveur).

```bash
cd fivem/test && npm ci && npm test    # moteur, SQL sur MariaDB/MySQL (si joignable), harnais FiveM simulé
python3 fivem/e2e/run.py                # parcours complet contre un vrai serveur + MariaDB + launcher Rust
```
