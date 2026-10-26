#!/usr/bin/env bash
# =============================================================================
#  FiveM Base Manager — installation en une commande sur un VPS Ubuntu / Debian
#  (Docker + PostgreSQL + site + HTTPS automatique avec Caddy / Let's Encrypt)
#
#    sudo ./deploy/install.sh --domain mabase.fr
#
#  Relançable à volonté : conserve les secrets existants, met à jour la configuration.
#  Options : --domain D  --email E  --branch B  --repo URL  --token GITHUB_TOKEN  --dir /opt/fbm  --yes (sans questions)
# =============================================================================
set -Eeuo pipefail

REPO_URL="${FBM_REPO:-https://github.com/mz311/areazea.git}"
BRANCH="${FBM_BRANCH:-claude/disponibilite-neg8vu}"
APP_DIR="${FBM_DIR:-/opt/fbm}"
DOMAIN="${FBM_DOMAIN:-}"
EMAIL="${FBM_EMAIL:-}"
GH_TOKEN="${GITHUB_TOKEN:-}"
ASSUME_YES=0
PLACEHOLDER_ID="000000000000000000"
PLACEHOLDER_SECRET="a-renseigner"

c_ok=$'\033[32m'; c_warn=$'\033[33m'; c_err=$'\033[31m'; c_dim=$'\033[2m'; c_off=$'\033[0m'
step() { printf '\n%s▶ %s%s\n' "$c_ok" "$*" "$c_off"; }
info() { printf '  %s\n' "$*"; }
ok()   { printf '  %s✔%s %s\n' "$c_ok" "$c_off" "$*"; }
warn() { printf '  %s⚠ %s%s\n' "$c_warn" "$*" "$c_off" >&2; }
die()  { printf '\n%s✘ %s%s\n' "$c_err" "$*" "$c_off" >&2; exit 1; }

usage() { sed -n '2,10p' "$0" | sed 's/^# \{0,1\}//'; exit 0; }

parse_args() {
  while [ $# -gt 0 ]; do
    case "$1" in
      --domain) DOMAIN="${2:-}"; shift 2 ;;
      --email)  EMAIL="${2:-}"; shift 2 ;;
      --branch) BRANCH="${2:-}"; shift 2 ;;
      --repo)   REPO_URL="${2:-}"; shift 2 ;;
      --token)  GH_TOKEN="${2:-}"; shift 2 ;;
      --dir)    APP_DIR="${2:-}"; shift 2 ;;
      --yes|-y) ASSUME_YES=1; shift ;;
      -h|--help) usage ;;
      *) die "Option inconnue : $1 (voir --help)" ;;
    esac
  done
}

has_tty() { [ "$ASSUME_YES" = 0 ] && [ -r /dev/tty ] && [ -w /dev/tty ]; }

# ask VAR "Question" [secret] — lit sur le terminal même si le script arrive par un pipe (curl | bash)
ask() {
  local __var=$1 __q=$2 __secret=${3:-} __v=""
  has_tty || return 1
  if [ -n "$__secret" ]; then
    read -r -s -p "  $__q : " __v </dev/tty >/dev/tty 2>&1 || true
    printf '\n' >/dev/tty
  else
    read -r -p "  $__q : " __v </dev/tty >/dev/tty 2>&1 || true
  fi
  printf -v "$__var" '%s' "$__v"
}

valid_domain() { [[ "$1" =~ ^([a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]{2,}$ ]]; }
# jeton / identifiant : caractères sûrs uniquement (la valeur est écrite dans un fichier .env)
valid_token()  { [[ "$1" =~ ^[A-Za-z0-9._,-]+$ ]]; }

# ───────────────────────────── fichiers .env ─────────────────────────────

# set_env FICHIER CLE VALEUR — remplace la ligne CLE=… ou l'ajoute (via awk : aucun caractère spécial à échapper)
set_env() {
  local f=$1 k=$2 v=$3 tmp
  tmp=$(mktemp)
  K="$k" V="$v" awk 'BEGIN { k = ENVIRON["K"]; v = ENVIRON["V"]; d = 0 }
    index($0, k "=") == 1 { print k "=" v; d = 1; next }
    { print }
    END { if (!d) print k "=" v }' "$f" >"$tmp"
  cat "$tmp" >"$f"
  rm -f "$tmp"
}

get_env() { # get_env FICHIER CLE
  [ -f "$1" ] || return 0
  awk -v k="$2" 'index($0, k "=") == 1 { sub(/^[^=]*=/, ""); print; exit }' "$1"
}

random_secret() { openssl rand -base64 48 | tr -d '\n' | tr '+/' '-_' | tr -d '='; }
random_hex()    { openssl rand -hex 24; }

# ask_conf FICHIER CLE "Libellé" valeur_par_défaut [secret] — Entrée conserve la valeur actuelle
ask_conf() {
  local f=$1 key=$2 label=$3 placeholder=$4 secret=${5:-} cur val=""
  cur=$(get_env "$f" "$key")
  if [ -n "$cur" ] && [ "$cur" != "$placeholder" ]; then label="$label (Entrée = conserver)"; fi
  if ask val "$label" "$secret" && [ -n "$val" ]; then
    valid_token "$val" || die "Valeur invalide pour $key : seuls les lettres, chiffres et . _ - , sont acceptés."
    set_env "$f" "$key" "$val"
  elif [ -z "$cur" ]; then
    set_env "$f" "$key" "$placeholder"
  fi
}

write_env_files() {
  local web_env="$APP_DIR/web/.env" root_env="$APP_DIR/.env"
  [ -f "$web_env" ] || cp "$APP_DIR/web/.env.example" "$web_env"
  [ -f "$root_env" ] || : >"$root_env"
  chmod 600 "$web_env" "$root_env"

  set_env "$root_env" COMPOSE_PROJECT_NAME fbm
  [ -n "$(get_env "$root_env" POSTGRES_PASSWORD)" ] || set_env "$root_env" POSTGRES_PASSWORD "$(random_hex)"

  set_env "$web_env" APP_URL "https://$DOMAIN"
  local secret
  secret=$(get_env "$web_env" APP_SECRET)
  if [ -z "$secret" ] || [[ "$secret" == *changez-moi* ]] || [ "${#secret}" -lt 32 ]; then
    set_env "$web_env" APP_SECRET "$(random_secret)"
  fi

  if has_tty; then
    {
      printf '\n  %sConnexion Discord (voir docs/discord.md). Vous pouvez tout passer avec Entrée et y revenir plus tard :%s\n' "$c_dim" "$c_off"
      printf '  %srelancez simplement ce script. URL de redirection à déclarer dans le portail Discord :%s\n' "$c_dim" "$c_off"
      printf '  %shttps://%s/api/auth/discord/callback%s\n\n' "$c_dim" "$DOMAIN" "$c_off"
    } >/dev/tty
  fi
  ask_conf "$web_env" DISCORD_CLIENT_ID "Client ID de l'application Discord" "$PLACEHOLDER_ID"
  ask_conf "$web_env" DISCORD_CLIENT_SECRET "Client Secret (masqué)" "$PLACEHOLDER_SECRET" secret
  ask_conf "$web_env" DISCORD_GUILD_ID "ID de votre serveur Discord" "$PLACEHOLDER_ID"
  ask_conf "$web_env" ADMIN_DISCORD_IDS "Votre ID Discord (administrateur ; plusieurs : séparés par des virgules)" ""
  ask_conf "$web_env" DISCORD_BOT_TOKEN "Jeton du bot (optionnel, masqué)" "" secret
}

write_caddyfile() {
  {
    if [ -n "$EMAIL" ]; then printf '{\n\temail %s\n}\n\n' "$EMAIL"; fi
    cat <<CADDY
$DOMAIN {
	encode zstd gzip

	# Archives de la base : jusqu'à 4 Go, envoyées en flux (le proxy ne les met pas en tampon)
	request_body {
		max_size 4GB
	}

	reverse_proxy web:3000 {
		# L'application s'appuie sur X-Real-IP (limitation de débit, journal d'audit) : on l'impose ici,
		# pour qu'un visiteur ne puisse pas la forger.
		header_up X-Real-IP {remote_host}
	}
}
CADDY
  } >"$APP_DIR/Caddyfile"
}

# ───────────────────────────── étapes ─────────────────────────────

mem_mb() { awk '/MemTotal/ { print int($2 / 1024) }' /proc/meminfo; }

check_system() {
  [ "$(id -u)" = 0 ] || die "Lancez ce script en root : sudo ./deploy/install.sh …"
  command -v apt-get >/dev/null || die "Ce script supporte Ubuntu / Debian (apt)."
  # shellcheck disable=SC1091
  . /etc/os-release 2>/dev/null || true
  info "Système : ${PRETTY_NAME:-inconnu}"
  local disk_gb
  disk_gb=$(df -BG --output=avail / | tail -1 | tr -dc '0-9')
  info "Mémoire : $(mem_mb) Mo — disque libre : ${disk_gb} Go"
  [ "$(mem_mb)" -ge 1500 ] || warn "Moins de 2 Go de RAM : un fichier d'échange sera ajouté ; la construction sera lente."
  [ "${disk_gb:-0}" -ge 10 ] || die "Moins de 10 Go libres : insuffisant."
}

# Plesk / Apache / nginx déjà installés sur le VPS occuperaient les ports 80 et 443
check_ports() {
  local busy
  busy=$(ss -ltnpH 'sport = :80 or sport = :443' 2>/dev/null | grep -v 'docker-proxy' || true)
  if [ -n "$busy" ]; then
    printf '%s\n' "$busy" >&2
    die "Les ports 80/443 sont déjà utilisés (ci-dessus, probablement Apache, nginx ou Plesk). Arrêtez-les (systemctl disable --now apache2 nginx) ou choisissez une image de VPS Ubuntu vierge."
  fi
}

ensure_swap() {
  if [ "$(mem_mb)" -lt 3500 ] && [ "$(awk '/SwapTotal/ { print $2 }' /proc/meminfo)" = 0 ]; then
    info "Ajout d'un fichier d'échange de 2 Go (la construction de Next.js est gourmande)…"
    fallocate -l 2G /swapfile 2>/dev/null || dd if=/dev/zero of=/swapfile bs=1M count=2048 status=none
    chmod 600 /swapfile && mkswap /swapfile >/dev/null && swapon /swapfile
    grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >>/etc/fstab
    ok "Fichier d'échange activé"
  fi
}

public_ip() { curl -4 -fsS --max-time 8 https://api.ipify.org 2>/dev/null || curl -4 -fsS --max-time 8 https://ifconfig.me 2>/dev/null || true; }

check_dns() {
  local ip dns
  ip=$(public_ip)
  dns=$(getent ahostsv4 "$DOMAIN" 2>/dev/null | awk '{ print $1; exit }' || true)
  info "IP de ce serveur : ${ip:-inconnue} — $DOMAIN pointe vers : ${dns:-rien (aucun enregistrement DNS)}"
  if [ -z "$dns" ]; then
    warn "Le domaine ne pointe encore nulle part : créez un enregistrement DNS A  $DOMAIN → ${ip:-IP du serveur}. Le site s'installera, mais le HTTPS ne démarrera qu'une fois le DNS propagé (parfois quelques heures)."
  elif [ -n "$ip" ] && [ "$dns" != "$ip" ]; then
    warn "Le domaine pointe vers $dns et non vers ce serveur ($ip) : corrigez l'enregistrement A, sinon le certificat HTTPS ne pourra pas être délivré."
  else
    ok "DNS correct"
  fi
}

install_packages() {
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq
  apt-get install -y -qq ca-certificates curl git openssl cron gnupg iproute2 >/dev/null
  if ! command -v docker >/dev/null || ! docker compose version >/dev/null 2>&1; then
    info "Installation de Docker (script officiel get.docker.com)…"
    curl -fsSL https://get.docker.com | sh >/dev/null 2>&1 || die "Installation de Docker impossible."
  fi
  systemctl enable --now docker >/dev/null 2>&1 || true
  ok "Docker $(docker --version | awk '{ print $3 }' | tr -d ,) — Compose $(docker compose version --short)"
}

configure_firewall() {
  if command -v ufw >/dev/null && ufw status 2>/dev/null | grep -q "Status: active"; then
    ufw allow 22/tcp >/dev/null; ufw allow 80/tcp >/dev/null; ufw allow 443/tcp >/dev/null; ufw allow 443/udp >/dev/null
    ok "Pare-feu ufw : ports 22, 80 et 443 ouverts"
  fi
  info "Si le HTTPS ne répond pas : ouvrez aussi les ports 80 et 443 dans le pare-feu du panneau IONOS (Réseau → Politiques de pare-feu)."
}

# git avec jeton, sans jamais l'écrire dans la configuration du dépôt
git_auth() {
  if [ -n "$GH_TOKEN" ]; then
    local b64
    b64=$(printf 'x-access-token:%s' "$GH_TOKEN" | base64 -w0)
    git -c "http.extraheader=AUTHORIZATION: basic $b64" "$@"
  else
    git "$@"
  fi
}

fetch_code() {
  if [ -d "$APP_DIR/.git" ]; then
    info "Mise à jour du code dans $APP_DIR (branche $BRANCH)…"
    if [ -z "$GH_TOKEN" ] && [ -r /etc/fbm/github-token ]; then GH_TOKEN=$(cat /etc/fbm/github-token); fi
    GIT_TERMINAL_PROMPT=0 git_auth -C "$APP_DIR" fetch --quiet origin "$BRANCH" || die "git fetch impossible (dépôt privé ? relancez avec --token)."
    git -C "$APP_DIR" checkout --quiet -B "$BRANCH" "origin/$BRANCH"
  else
    [ ! -e "$APP_DIR" ] || [ -z "$(ls -A "$APP_DIR" 2>/dev/null)" ] || die "$APP_DIR existe et n'est pas un dépôt FiveM Base Manager."
    info "Téléchargement du code ($REPO_URL, branche $BRANCH)…"
    if ! GIT_TERMINAL_PROMPT=0 git_auth clone --quiet --depth 1 --branch "$BRANCH" "$REPO_URL" "$APP_DIR" 2>/tmp/fbm-clone.err; then
      if [ -z "$GH_TOKEN" ] && has_tty; then
        warn "Le dépôt semble privé. Créez un jeton GitHub en lecture seule : github.com → Settings → Developer settings → Fine-grained tokens → dépôt « areazea » → Contents : Read-only."
        ask GH_TOKEN "Collez le jeton GitHub (masqué)" secret || true
        valid_token "${GH_TOKEN:-x y}" || die "Jeton absent ou invalide."
        rm -rf "$APP_DIR"
        GIT_TERMINAL_PROMPT=0 git_auth clone --quiet --depth 1 --branch "$BRANCH" "$REPO_URL" "$APP_DIR" \
          || die "Téléchargement impossible : jeton sans accès au dépôt, ou branche « $BRANCH » inexistante."
      else
        cat /tmp/fbm-clone.err >&2
        die "Téléchargement impossible : dépôt privé (relancez avec --token), ou branche « $BRANCH » inexistante (--branch)."
      fi
    fi
  fi
  if [ -n "$GH_TOKEN" ]; then
    mkdir -p /etc/fbm
    (umask 077 && printf '%s' "$GH_TOKEN" >/etc/fbm/github-token)
  fi
  ok "Code récupéré : $(git -C "$APP_DIR" log -1 --format='%h %s')"
}

compose() { (cd "$APP_DIR" && docker compose -f docker-compose.yml -f deploy/docker-compose.prod.yml "$@"); }

start_stack() {
  step "Construction et démarrage (5 à 10 minutes la première fois, patientez)"
  if ! compose up -d --build >/tmp/fbm-build.log 2>&1; then
    tail -40 /tmp/fbm-build.log >&2
    die "La construction a échoué (journal complet : /tmp/fbm-build.log)."
  fi
  ok "Conteneurs démarrés"
  info "Attente du démarrage du site…"
  for _ in $(seq 1 90); do
    if curl -fsS --max-time 3 http://127.0.0.1:3000/api/public/latest >/dev/null 2>&1; then
      ok "Site démarré"
      return 0
    fi
    sleep 2
  done
  compose logs --tail 40 web migrate >&2 || true
  die "Le site ne répond pas après 3 minutes (journaux ci-dessus). Relancez ce script, ou : cd $APP_DIR && docker compose logs web"
}

wait_https() {
  info "Obtention du certificat HTTPS (Let's Encrypt)…"
  local code
  for _ in $(seq 1 30); do
    code=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 8 "https://$DOMAIN/api/public/latest" 2>/dev/null || true)
    if [ "$code" = 200 ]; then
      ok "https://$DOMAIN répond"
      return 0
    fi
    sleep 4
  done
  warn "https://$DOMAIN ne répond pas encore. Causes fréquentes : DNS pas encore propagé, ports 80/443 fermés dans le pare-feu IONOS. Journaux : cd $APP_DIR && docker compose logs caddy"
  return 1
}

install_cron() {
  chmod +x "$APP_DIR"/deploy/*.sh
  mkdir -p "$APP_DIR/backups"
  printf '%s\n%s\n' \
    '# Sauvegarde quotidienne de la base de données (14 jours conservés)' \
    "30 3 * * * root $APP_DIR/deploy/backup.sh >>/var/log/fbm-backup.log 2>&1" >/etc/cron.d/fbm-backup
  ok "Sauvegarde quotidienne de la base de données programmée (03h30)"
}

summary() {
  local web_env="$APP_DIR/web/.env" todo=0
  if [ "$(get_env "$web_env" DISCORD_CLIENT_ID)" = "$PLACEHOLDER_ID" ] || [ "$(get_env "$web_env" DISCORD_CLIENT_SECRET)" = "$PLACEHOLDER_SECRET" ]; then todo=1; fi
  printf '\n%s════════════════════════════════════════════════════════════%s\n' "$c_ok" "$c_off"
  printf '  Site            https://%s\n' "$DOMAIN"
  printf '  Administration  https://%s/admin  (compte Discord listé dans ADMIN_DISCORD_IDS)\n' "$DOMAIN"
  printf '  Dossier         %s\n' "$APP_DIR"
  if [ "$todo" = 1 ]; then
    printf '\n  %sConnexion Discord à configurer%s : suivez docs/discord.md, puis relancez\n' "$c_warn" "$c_off"
    printf '    sudo %s/deploy/install.sh --domain %s\n' "$APP_DIR" "$DOMAIN"
    printf '  (Entrée pour conserver ce qui est renseigné). Redirection à déclarer dans Discord :\n'
    printf '    https://%s/api/auth/discord/callback\n' "$DOMAIN"
  fi
  printf '\n  Mettre à jour le site : sudo %s/deploy/update.sh\n' "$APP_DIR"
  printf '  Journaux              : cd %s && docker compose logs -f web\n' "$APP_DIR"
  printf '  Sauvegarde complète   : sudo %s/deploy/backup.sh --files\n' "$APP_DIR"
  printf '%s════════════════════════════════════════════════════════════%s\n' "$c_ok" "$c_off"
}

main() {
  parse_args "$@"
  step "Vérification du serveur"
  check_system
  if [ -z "$DOMAIN" ]; then ask DOMAIN "Nom de domaine du site (ex. mabase.fr)" || true; fi
  [ -n "$DOMAIN" ] || die "Indiquez le domaine : --domain mabase.fr"
  DOMAIN=$(printf '%s' "$DOMAIN" | tr '[:upper:]' '[:lower:]' | sed -E 's#^https?://##; s#/.*$##')
  valid_domain "$DOMAIN" || die "Nom de domaine invalide : $DOMAIN"
  if [ -n "$EMAIL" ] && ! [[ "$EMAIL" =~ ^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$ ]]; then die "Adresse e-mail invalide : $EMAIL"; fi
  step "Installation des composants"
  ensure_swap
  install_packages
  check_ports
  check_dns
  configure_firewall
  step "Code de l'application"
  fetch_code
  step "Configuration"
  write_env_files
  write_caddyfile
  ok "Configuration écrite (secrets générés, droits 600)"
  start_stack
  install_cron
  wait_https || true
  summary
}

# permet de tester les fonctions : FBM_SOURCE_ONLY=1 source deploy/install.sh
if [ "${FBM_SOURCE_ONLY:-0}" != 1 ]; then main "$@"; fi
