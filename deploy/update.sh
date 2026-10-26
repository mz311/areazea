#!/usr/bin/env bash
# Met à jour le site (code + migrations de base de données) : sudo /opt/fbm/deploy/update.sh
set -Eeuo pipefail
APP_DIR="${FBM_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
cd "$APP_DIR"
[ "$(id -u)" = 0 ] || { echo "Lancez en root : sudo $0" >&2; exit 1; }
COMPOSE=(docker compose -f docker-compose.yml -f deploy/docker-compose.prod.yml)

BRANCH=$(git rev-parse --abbrev-ref HEAD)
echo "▶ Sauvegarde de la base de données avant mise à jour"
./deploy/backup.sh

echo "▶ Récupération du code (branche $BRANCH)"
if [ -r /etc/fbm/github-token ]; then
  B64=$(printf 'x-access-token:%s' "$(cat /etc/fbm/github-token)" | base64 -w0)
  GIT_TERMINAL_PROMPT=0 git -c "http.extraheader=AUTHORIZATION: basic $B64" fetch --quiet origin "$BRANCH"
else
  GIT_TERMINAL_PROMPT=0 git fetch --quiet origin "$BRANCH"
fi
BEFORE=$(git rev-parse --short HEAD)
git reset --quiet --hard "origin/$BRANCH"
AFTER=$(git rev-parse --short HEAD)
if [ "$BEFORE" != "$AFTER" ]; then git log --oneline "$BEFORE..$AFTER" | head -20; else echo "  (code déjà à jour : $AFTER)"; fi
chmod +x deploy/*.sh

echo "▶ Reconstruction et redémarrage (les migrations de base de données s'appliquent automatiquement)"
"${COMPOSE[@]}" up -d --build
for _ in $(seq 1 60); do
  if curl -fsS --max-time 3 http://127.0.0.1:3000/api/public/latest >/dev/null 2>&1; then
    echo "✔ Site à jour ($AFTER)"
    docker image prune -f >/dev/null
    exit 0
  fi
  sleep 2
done
"${COMPOSE[@]}" logs --tail 40 web migrate >&2
echo "✘ Le site ne répond pas : voir les journaux ci-dessus." >&2
echo "  Retour arrière : cd $APP_DIR && git reset --hard $BEFORE && ${COMPOSE[*]} up -d --build" >&2
exit 1
