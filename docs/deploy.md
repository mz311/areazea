# Mettre le site en ligne (VPS IONOS ou tout VPS Ubuntu)

Le site a besoin d'un **serveur qui tourne en permanence** (Node.js, PostgreSQL, fichiers de plusieurs Go) : un **VPS Linux**. L'« Hébergement Web » IONOS (PHP / FTP) **ne convient pas**.

## 1. Prendre le VPS (IONOS)

| | Minimum | Confortable |
|---|---|---|
| Produit | **VPS Linux** (Serveurs & Cloud → VPS) | idem |
| Système | **Ubuntu 24.04** (image vierge, sans Plesk) | idem |
| RAM | 2 Go | 4 Go |
| Disque | 40 Go | 80 Go ou plus (chaque version de votre base est stockée ; seuls les fichiers modifiés sont dupliqués) |

Notez l'**adresse IP** du VPS et le **mot de passe root** (ou ajoutez votre clé SSH).

## 2. Faire pointer le domaine

IONOS → **Domaines & SSL → votre domaine → DNS** → ajouter un enregistrement :

| Type | Nom d'hôte | Valeur |
|---|---|---|
| **A** | `@` (ou `base` pour `base.mondomaine.fr`) | l'IP du VPS |

La propagation prend de quelques minutes à quelques heures. Vérification : `nslookup mondomaine.fr`.

> Utilisez ce domaine (ou ce sous-domaine) **uniquement** pour le site. Si vous aviez un « Hébergement Web » IONOS sur le même domaine, le sous-domaine `base.` évite tout conflit.

## 3. Ouvrir les ports dans le pare-feu IONOS

Panneau IONOS → **Réseau → Politiques de pare-feu** → autoriser en entrée **TCP 22** (SSH), **TCP 80** et **TCP 443** (et UDP 443). Sans cela, le certificat HTTPS ne peut pas être délivré.

## 4. Installer — une commande

Connectez-vous au VPS : bouton **Console / KVM** du panneau IONOS, ou `ssh root@IP-DU-VPS`. Puis :

```bash
curl -fsSL https://raw.githubusercontent.com/mz311/areazea/claude/disponibilite-neg8vu/deploy/install.sh | sudo bash -s -- --domain mabase.fr --email vous@exemple.fr
```

Le script (relançable sans risque) :

1. vérifie le serveur (RAM, disque, ports 80/443 libres, DNS) et ajoute un fichier d'échange si la RAM est faible ;
2. installe **Docker** ;
3. télécharge le code dans `/opt/fbm` ;
4. **génère tous les secrets** (mot de passe PostgreSQL, `APP_SECRET`) dans des fichiers en droits `600` ;
5. vous pose les questions **Discord** (Entrée pour passer et y revenir plus tard) ;
6. construit et démarre : **PostgreSQL**, migrations, **le site** et **Caddy** (certificat HTTPS Let's Encrypt automatique, renouvelé tout seul) ;
7. programme une **sauvegarde quotidienne** de la base de données.

Première installation : 5 à 10 minutes (construction du site). À la fin, il affiche l'adresse du site et ce qu'il reste à faire.

### Si le script vous dit que le DNS n'est pas prêt
Le site s'installe quand même ; le HTTPS démarrera tout seul dès que le DNS pointera vers le VPS. Vous pouvez aussi relancer le script plus tard.

## 5. Connecter Discord

Suivez **[discord.md](discord.md)**. Valeurs à retenir pour ce déploiement :

* URL de redirection OAuth2 : `https://mabase.fr/api/auth/discord/callback`
* Puis relancez `sudo /opt/fbm/deploy/install.sh --domain mabase.fr` : il redemande les valeurs Discord (Entrée = conserver ce qui existe) et redémarre.
* Votre ID Discord dans `ADMIN_DISCORD_IDS` fait de vous l'administrateur : ouvrez `https://mabase.fr/admin`.

## 6. Après l'installation

| Action | Commande (sur le VPS) |
|---|---|
| Mettre le site à jour (nouveau code, migrations) | `sudo /opt/fbm/deploy/update.sh` |
| Voir les journaux | `cd /opt/fbm && docker compose logs -f web` |
| Redémarrer | `cd /opt/fbm && docker compose -f docker-compose.yml -f deploy/docker-compose.prod.yml restart` |
| Sauvegarde manuelle (base + fichiers des versions) | `sudo /opt/fbm/deploy/backup.sh --files` |
| Modifier la configuration | `sudo nano /opt/fbm/web/.env` puis `cd /opt/fbm && docker compose -f docker-compose.yml -f deploy/docker-compose.prod.yml up -d` |

* `update.sh` fait d'abord une sauvegarde de la base, puis suit la branche installée.
* **Sauvegardes** : la base est sauvegardée chaque nuit dans `/opt/fbm/backups` (14 jours). Les fichiers des versions ne le sont qu'avec `--files` : pour une vraie protection, activez aussi les **snapshots / sauvegardes automatiques du VPS** dans le panneau IONOS et copiez `/opt/fbm/backups` hors du serveur.
* **Stockage S3** : pour sortir les fichiers du VPS (R2, S3, IONOS Object Storage…), renseignez `STORAGE_DRIVER=s3` et `S3_*` dans `web/.env` (voir `.env.example`).
* **Sécurité du serveur** : activez les mises à jour de sécurité automatiques (`apt install unattended-upgrades`), utilisez une clé SSH plutôt que le mot de passe root, et ne partagez jamais `/opt/fbm/web/.env`.

## Dépannage

| Symptôme | Cause probable |
|---|---|
| « Les ports 80/443 sont déjà utilisés » | Image avec Apache / Plesk : `systemctl disable --now apache2 nginx`, ou réinstallez une image Ubuntu vierge |
| HTTPS ne répond pas, `docker logs --tail 40 fbm-caddy-1` parle d'*ACME*, *challenge* ou *timeout* | DNS pas encore propagé ou ports 80/443 fermés dans le pare-feu IONOS |
| Construction qui échoue (« killed ») | Mémoire insuffisante : 2 Go minimum (le script ajoute du swap) |
| Le site s'affiche mais « Connexion Discord » échoue | Valeurs Discord provisoires : relancez `install.sh`, vérifiez l'URL de redirection |
| Import d'une grosse archive qui échoue | Disque plein (`df -h`) ou `MAX_UPLOAD_MB` dans `web/.env` |

## Ce que le script ne fait pas

* Il ne commande ni ne configure rien chez IONOS (VPS, DNS, pare-feu) : ces étapes sont dans votre compte.
* Il ne crée pas l'application Discord : voir [discord.md](discord.md).
* Il n'installe pas la ressource `fbm-updater` sur vos serveurs FiveM : voir [`fivem/fbm-updater`](../fivem/fbm-updater/README.md).

## Test du script

`deploy/test-install.sh` vérifie sans Docker ni réseau la génération de la configuration (secrets conservés à la relance, validation des saisies, Caddyfile) ; `shellcheck deploy/*.sh` est propre.
