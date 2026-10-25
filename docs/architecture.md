# Architecture & API

## Modèle de données (Prisma)

| Table | Rôle |
|---|---|
| `User` | compte Discord (`discordId`), rôle calculé depuis les rôles Discord, **surcharge** manuelle (`roleOverride`), `inGuild`, `banned` |
| `Session` | sessions du site (cookie `httpOnly`, seul le **hash SHA-256** du jeton est stocké) |
| `LauncherToken` | jetons du launcher / de la CLI (`fvl_…`), hashés, révocables, `lastUsedAt` |
| `Version` | numéro semver unique, canal (`STABLE`/`BETA`), état (`DRAFT`/`PUBLISHED`), rôle minimum, `isCurrent` (**une seule version courante par canal**, garanti par un index unique partiel), **manifeste** (JSON), archive ZIP + son SHA-256 |
| `Change` | entrées du changelog (`NEW`/`FIX`/`IMPROVEMENT`, image optionnelle) |
| `MediaAsset` | images du changelog (type vérifié par signature, SVG refusé) |
| `Download` | statistiques (`ZIP`, `INSTALL`, `UPDATE`, `REPAIR`) |
| `Announcement`, `Setting`, `AuditLog` | annonces, réglages du site, journal des actions admin |

## Stockage (privé)

Clés dans le bucket / dossier : `blobs/<2 premiers hex>/<sha256>` (un fichier de la base = un blob **dédupliqué** entre versions), `archives/<version>-<nonce>.zip`, `media/<id>`. Aucune URL publique : l'accès se fait par **liens temporaires** (S3 présignés, ou lien HMAC `/api/files/<jeton>` pour le stockage local).

## Manifeste

```jsonc
{
  "files": [{ "path": "resources/[core]/x/fxmanifest.lua", "sha256": "…64 hex…", "size": 123 }],
  "managedDirs": ["resources"],              // dossiers où le launcher peut supprimer ses anciens fichiers
  "protected": ["server.cfg", "**/config.lua", "txData/**"]   // jamais écrasés / supprimés chez le joueur
}
```

* `digest` = SHA-256 du JSON compact `{"files":[[path,sha,size]…],"managedDirs":[…],"protected":[…]}` ; le serveur l'envoie (`manifestSha256`) et le launcher le recalcule (la même valeur est testée côté TypeScript **et** Rust).
* Motifs glob : `*` (sans `/`), `**` (traverse les dossiers), `?` ; insensibles à la casse (Windows).

## Mise à jour différentielle

```
launcher                                         serveur
   │ GET /api/launcher/latest?channel=STABLE ───►│ rôle ≥ minRole ? maintenance ?
   │◄── version + manifeste + manifestSha256 ────│
   │  plan : pour chaque fichier du manifeste
   │    protégé & présent        → conservé
   │    absent / taille ≠ / hash ≠ → à télécharger   (mode réparation : tout est re-haché)
   │    dans .fbm/state.json mais plus dans le manifeste, dossier géré, non protégé → à supprimer
   │ POST /api/launcher/blobs {version, hashes} ─►│ chaque hash doit appartenir au manifeste de la version
   │◄── liens temporaires (≤ 500) ───────────────│
   │  téléchargement parallèle → .fbm/staging/<txn>/<sha> (taille + SHA-256, 3 essais, liens renouvelés)
   │  journal → sauvegarde des fichiers remplacés → écriture → re-vérification → état
   │  erreur à n'importe quel moment ⇒ restauration complète
   │ POST /api/launcher/report ──────────────────►│ statistiques
```

Après un **rollback** (version courante plus ancienne), la même mécanique s'applique dans l'autre sens.

## API

Toutes les réponses d'erreur : `{ "error": "message", "code": "identifiant_stable" }`. Auth : **S** = cookie de session (+ contrôle `Origin` sur les requêtes modifiantes), **B** = `Authorization: Bearer fvl_…`.

| Route | Auth | Description |
|---|---|---|
| `GET /api/auth/discord/login` · `/callback` | — | OAuth2 (state + PKCE) |
| `POST /api/auth/logout` · `GET /api/auth/me` | S | session |
| `GET /api/public/latest` · `/status` · `/updates` | — | dernière version + compteur, statut des services, changelog public |
| `POST /api/download/{version}/link` | S | lien ZIP temporaire (+ SHA-256, taille) — rôle et appartenance au serveur vérifiés |
| `GET /api/files/{jeton}` | lien signé | téléchargement (stockage local) |
| `GET/POST /api/account/tokens` · `DELETE …/{id}` | S | jetons launcher (clair affiché **une fois**) ; flux loopback via `port` + `state` |
| `GET /api/launcher/me` · `/latest` | B | profil ; version cible + manifeste (`?channel=` ou `?version=`) |
| `POST /api/launcher/blobs` · `/report` | B | liens de téléchargement des blobs ; statistiques |
| `GET /api/media/{id}` | — | images du changelog |
| `GET /api/admin/versions` · `/{id}` | S admin | liste / détail + diff |
| `POST /api/admin/versions/upload?version=&channel=&minRole=&stripRoot=` | S admin | corps brut `application/zip` (en flux) → brouillon + manifeste |
| `PUT/DELETE /api/admin/versions/{id}` | S admin | changelog, règles, rôle, suppression |
| `POST /api/admin/versions/{id}/publish` · `/rollback` | S admin | publier ; définir comme version courante |
| `POST /api/admin/media` | S admin | upload d'image |
| `…/announcements`, `…/users`, `…/stats`, `…/audit`, `…/settings`, `…/storage/gc` | S admin | gestion |
