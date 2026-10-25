# Launcher

## Utilisation (joueurs)

1. Installer et lancer le launcher → **Se connecter avec Discord** (le navigateur s'ouvre ; autorisez le launcher).
2. **Choisir…** le dossier d'installation (un dossier existant convient : les fichiers identiques à la base sont reconnus et **non retéléchargés**).
3. **Installer** / **Mettre à jour** : barre de progression, vitesse, temps restant. Le launcher vérifie les nouvelles versions au démarrage puis toutes les 5 minutes (notification native).
4. **Réparer mon installation** : re-vérifie tous les fichiers (SHA-256) et retélécharge ceux qui sont absents ou corrompus.
5. **Ouvrir le dossier** ; **Options** : canal (stable / bêta) et fichiers protégés supplémentaires.

Si l'administrateur fait un **rollback**, le launcher propose « Revenir à vX » et restaure l'ancienne version.

## Garanties

| Garantie | Mécanisme |
|---|---|
| Téléchargement minimal | Comparaison avec le manifeste (SHA-256) ; seuls les fichiers nouveaux / modifiés sont téléchargés ; un contenu identique n'est téléchargé qu'une fois |
| Intégrité | Chaque fichier est vérifié (taille + SHA-256) **avant** installation, puis re-vérifié **après** ; 3 tentatives avec renouvellement des liens expirés |
| Atomicité | Les fichiers remplacés sont **sauvegardés** (`.fbm/backup`), l'opération est **journalisée** (`.fbm/txn.json`). Erreur, annulation, disque plein, fichier verrouillé → **restauration automatique** ; après un crash, restauration au prochain démarrage |
| Configs protégées | Motifs du manifeste (`server.cfg`, `**/config.lua`, `**/config.json`, `txData/**`…) + vos motifs : **jamais écrasés ni supprimés** s'ils existent ; installés (valeurs par défaut) s'ils sont absents |
| Suppression limitée | Seuls sont supprimés les fichiers **installés par le launcher** (listés dans `.fbm/state.json`), situés dans un **dossier géré** du manifeste, **non protégés**. Vos propres fichiers/dossiers ne sont jamais touchés ; les fichiers à la racine ne sont jamais supprimés |
| Chemins sûrs | Refus de `..`, chemins absolus, lecteurs, antislash, noms réservés Windows, `.fbm`, liens symboliques — avant toute écriture |
| Secrets | Le jeton launcher est stocké dans le Gestionnaire d'informations d'identification Windows ; révocable depuis *Mon compte* ; jamais affiché |

Tout est dans le dossier d'installation sous `.fbm/` (état, journal, sauvegardes temporaires) — ne le supprimez pas.

## Compiler

```bash
cd launcher && npm ci
FBM_API_URL=https://base.example.com npx tauri build
```

* `FBM_API_URL` est lue **à la compilation** ; en release, seule une URL `https://` est acceptée. En développement (`npx tauri dev`), `FBM_API_URL` peut être redéfinie à l'exécution (`http://localhost:3000`).
* Nom, identifiant et icône : `src-tauri/tauri.conf.json`, `app-icon.png` puis `npm run icons`.
* Linux (développement) : `libwebkit2gtk-4.1-dev`, `libsoup-3.0-dev`, `librsvg2-dev`, `libayatana-appindicator3-dev`.
* **Signez l'installateur** (certificat de signature de code) pour éviter SmartScreen ; Tauri supporte `signCommand` / Azure Trusted Signing.

## CLI (serveurs dédiés, tests, avancés)

```bash
cargo build --release -p fbm-core --bin fbm-cli
fbm-cli --api https://base.example.com --token fvl_… --dir /srv/fivem status      # plan sans rien modifier
fbm-cli --api … --token … --dir /srv/fivem update   [--channel BETA] [--protect "resources/mon/**"]
fbm-cli --api … --token … --dir /srv/fivem repair
fbm-cli --dir /srv/fivem recover                                                  # annule une opération interrompue
```

Le jeton se crée depuis *Mon compte* ou via le flux du launcher ; `FBM_API` et `FBM_TOKEN` peuvent remplacer `--api` / `--token`.
