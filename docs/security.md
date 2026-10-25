# Sécurité

| Exigence | Implémentation | Où |
|---|---|---|
| OAuth2 Discord sécurisé | `state` aléatoire + **PKCE (S256)** dans un cookie signé HMAC (10 min) ; échange du code côté serveur ; secret client jamais exposé | `web/src/app/api/auth/discord/*` |
| Permissions côté serveur | Chaque route est déclarée avec `auth` + `minRole` dans un wrapper unique ; rôle effectif = surcharge admin ou rôle Discord ; les pages admin renvoient **404** aux non-admins | `web/src/lib/api.ts`, `web/src/app/admin/layout.tsx` |
| Sessions | cookie `httpOnly` + `SameSite=Lax` (+ `Secure` en https), hash en base, 14 jours ; bannissement = sessions et jetons détruits | `web/src/lib/auth/session.ts` |
| CSRF | requêtes modifiantes par cookie : `Origin` obligatoire et identique à `APP_URL` | `api.ts` |
| Jetons launcher | 256 bits, **hashés**, révocables, max 10 actifs/utilisateur ; flux loopback (`127.0.0.1:port`, port ≥ 1024, `state` aléatoire) | `web/src/app/api/account/tokens`, `launcher/src-tauri/src/main.rs` |
| Stockage privé | aucun accès public ; liens temporaires (S3 présignés ou HMAC) de 30 s à 1 h (défaut 5 min) | `web/src/lib/storage/*` |
| Pas d'accès à des blobs arbitraires | `/api/launcher/blobs` n'accepte que les hash du **manifeste** de la version demandée **et** accessible au rôle de l'utilisateur | `web/src/app/api/launcher/blobs` |
| Uploads malveillants | flux sur disque (jamais en mémoire), taille max, ZIP validé : chemins (zip-slip, absolus, `..`, antislash, lecteurs, noms réservés Windows, doublons de casse), **liens symboliques refusés**, fichiers chiffrés refusés, extensions bloquées (`.exe`, `.bat`, `.ps1`…), nombre de fichiers, taille par fichier et totale, **ratio de compression** (zip bomb) sur les tailles déclarées, que le décompresseur vérifie ensuite contre les octets réellement produits, avec un plafond de taille appliqué pendant la lecture | `web/src/lib/archive/*` |
| Images | type déterminé par **signature** (PNG/JPEG/GIF/WebP) ; SVG refusé ; servies avec `nosniff` et une CSP `sandbox` | `web/src/lib/image.ts`, `api/media` |
| Limitation de requêtes | fenêtre glissante par utilisateur ou IP sur les routes sensibles (`429` + `Retry-After`) | `web/src/lib/rate-limit.ts` |
| Secrets | uniquement dans `.env` côté serveur ; aucune variable `NEXT_PUBLIC_*` ; webhooks non modifiables depuis le site | `web/src/lib/env.ts` |
| HTTPS | HSTS, CSP stricte, `X-Frame-Options: DENY`, `nosniff`, `Referrer-Policy` ; le launcher **refuse** une URL non-https en release | `web/next.config.mjs`, `main.rs` |
| Redirections | `returnTo` limité aux chemins internes (pas d'open redirect) ; URL de logo / liens : `http(s)` ou chemin relatif uniquement (pas de `javascript:`) | `web/src/lib/redirect.ts`, `api/admin/settings` |
| Webhooks Discord | hôte restreint à `discord.com`, mentions limitées au rôle configuré, versions réservées → salon staff | `web/src/lib/webhooks.ts` |
| Journal d'audit | uploads, publications, rollbacks, rôles, bannissements, réglages, téléchargements ZIP, jetons — acteur, cible, IP, date | `web/src/lib/audit.ts` |
| Launcher côté client | chemins re-validés (même règles que le serveur), pas de suivi des liens symboliques, suppression limitée aux fichiers installés par lui, SHA-256 avant/après, restauration transactionnelle | `launcher/core/src` |

## Points d'attention pour l'exploitant

* **`X-Real-IP`** : derrière un reverse proxy, il doit être posé par *votre* proxy (voir `deploy/nginx.conf`), sinon la limitation de débit et le journal verront « unknown ».
* **Rate limiting en mémoire** : par instance ; passez à Redis pour du multi-instances.
* **Un administrateur de confiance** : l'upload d'une base est, par nature, la distribution de code Lua/JS à vos joueurs. Limitez `DISCORD_ROLE_ADMIN_IDS`, activez la 2FA Discord obligatoire pour les modérateurs, surveillez le journal d'audit.
* **Pas d'analyse antivirus** du contenu des archives (seulement le filtrage d'extensions) ; ajoutez un scan (ClamAV) dans `processArchive` si vos admins ne sont pas les seuls à fournir des archives.
* **Révocation** : bannir un utilisateur ou révoquer un jeton coupe immédiatement l'API ; les liens présignés déjà émis restent valables jusqu'à leur expiration (5 min par défaut).
* **Signature du launcher** : signez l'exécutable Windows ; les mises à jour *du launcher lui-même* ne sont pas gérées (seule la base l'est) — redistribuez un nouvel installateur.
