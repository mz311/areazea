#!/usr/bin/env bash
# Teste les fonctions de configuration de install.sh (sans Docker ni réseau) :
#   ./deploy/test-install.sh        puis validation du .env produit par le schéma du site (voir web/tests/deploy-env.test.ts)
# shellcheck disable=SC2034,SC2016,SC2015  # variables lues par les fonctions de install.sh ; valeurs littérales volontaires
set -Eeuo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
export FBM_SOURCE_ONLY=1
# shellcheck disable=SC1091
source "$HERE/install.sh"

T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
APP_DIR="$T/app"; mkdir -p "$APP_DIR/web"; cp "$ROOT/web/.env.example" "$APP_DIR/web/.env.example"
ASSUME_YES=1   # pas de terminal : aucune question
DOMAIN="mabase.fr"; EMAIL="admin@mabase.fr"
fail() { echo "✘ $*" >&2; exit 1; }
eq() { [ "$1" = "$2" ] || fail "$3 : attendu « $2 », obtenu « $1 »"; echo "  ✓ $3"; }

echo "set_env / get_env"
f="$T/x.env"; printf 'A=1\nB=a/b&c\n' >"$f"
set_env "$f" A '2$x&y/z' ; set_env "$f" C "nouveau"
eq "$(get_env "$f" A)" '2$x&y/z' "remplace sans échapper les caractères spéciaux"
eq "$(get_env "$f" B)" 'a/b&c' "ne touche pas aux autres lignes"
eq "$(get_env "$f" C)" 'nouveau' "ajoute une clé absente"
eq "$(get_env "$f" ZZZ)" '' "clé absente → vide"

echo "première installation (sans terminal)"
write_env_files
write_caddyfile
W="$APP_DIR/web/.env"; R="$APP_DIR/.env"
eq "$(get_env "$W" APP_URL)" "https://mabase.fr" "APP_URL en https"
sec=$(get_env "$W" APP_SECRET); [ "${#sec}" -ge 32 ] || fail "APP_SECRET trop court (${#sec})"
echo "  ✓ APP_SECRET généré (>= 32 caractères)"
eq "$(get_env "$W" DISCORD_CLIENT_ID)" "$PLACEHOLDER_ID" "Discord : valeur provisoire"
eq "$(get_env "$R" COMPOSE_PROJECT_NAME)" "fbm" "nom de projet compose (volumes fbm_*)"
eq "$(get_env "$R" COMPOSE_FILE)" "docker-compose.yml:deploy/docker-compose.prod.yml" "fichiers compose par défaut (caddy inclus)"
[ "$(get_env "$R" POSTGRES_PASSWORD | wc -c)" -ge 40 ] || fail "mot de passe PostgreSQL trop court"
echo "  ✓ mot de passe PostgreSQL généré"
eq "$(stat -c %a "$W")" "600" "droits du .env : 600"
grep -q "^mabase.fr {" "$APP_DIR/Caddyfile" && grep -q "email admin@mabase.fr" "$APP_DIR/Caddyfile" && grep -q "header_up X-Real-IP {remote_host}" "$APP_DIR/Caddyfile" || fail "Caddyfile incomplet"
echo "  ✓ Caddyfile : domaine, e-mail, X-Real-IP imposé"

echo "relance : les secrets sont conservés"
s1=$(get_env "$W" APP_SECRET); p1=$(get_env "$R" POSTGRES_PASSWORD)
set_env "$W" DISCORD_CLIENT_ID "123456789012345678"
DOMAIN="autre.fr"; write_env_files
eq "$(get_env "$W" APP_SECRET)" "$s1" "APP_SECRET inchangé"
eq "$(get_env "$R" POSTGRES_PASSWORD)" "$p1" "mot de passe PostgreSQL inchangé"
eq "$(get_env "$W" DISCORD_CLIENT_ID)" "123456789012345678" "valeur Discord déjà saisie conservée"
eq "$(get_env "$W" APP_URL)" "https://autre.fr" "APP_URL mis à jour"

echo "validation des saisies"
valid_domain "mabase.fr" && valid_domain "sous.domaine.mabase.co.uk" || fail "domaine valide refusé"
if valid_domain "pas un domaine" || valid_domain "http://x" || valid_domain "-a.fr" || valid_domain "a;rm -rf.fr"; then fail "domaine invalide accepté"; fi
valid_email "moi.nom+fbm@mabase.fr" && valid_email "a@b.co" || fail "e-mail valide refusé"
if valid_email 'votre@email.fr~' || valid_email "a b@x.fr" || valid_email "a@x" || valid_email 'a@x.fr;rm' || valid_email '@x.fr' || valid_email 'a@@x.fr'; then fail "e-mail invalide accepté"; fi
echo "  ✓ e-mails : « votre@email.fr~ » et injections refusés"
valid_token "AbC_123-x.y" && valid_token "111,222" || fail "jeton valide refusé"
if valid_token 'a b' || valid_token 'a$(x)' || valid_token 'a"b' || valid_token 'a#b'; then fail "jeton dangereux accepté"; fi
echo "  ✓ domaines et jetons : injections refusées"
echo "OK : fichiers générés dans $APP_DIR (copiés vers /tmp/fbm-deploy-test pour validation)"
rm -rf /tmp/fbm-deploy-test; mkdir -p /tmp/fbm-deploy-test; cp "$W" /tmp/fbm-deploy-test/web.env; cp "$APP_DIR/Caddyfile" /tmp/fbm-deploy-test/Caddyfile
