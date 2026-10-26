#!/usr/bin/env bash
# Sauvegarde dans /opt/fbm/backups : base de données (toujours ; 14 jours conservés).
# --files ajoute les fichiers des versions (volumineux ; 30 jours conservés).
# Restauration de la base : gunzip -c backups/db-AAAA-MM-JJ-HHMM.sql.gz | docker compose exec -T db psql -U fbm fbm
set -Eeuo pipefail
APP_DIR="${FBM_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
cd "$APP_DIR"
OUT="$APP_DIR/backups"
mkdir -p "$OUT"
TS=$(date +%F-%H%M)
umask 077

docker compose -f docker-compose.yml -f deploy/docker-compose.prod.yml exec -T db pg_dump -U fbm fbm | gzip >"$OUT/db-$TS.sql.gz"
if [ ! -s "$OUT/db-$TS.sql.gz" ] || [ "$(gzip -dc "$OUT/db-$TS.sql.gz" | head -c 100 | wc -c)" -lt 50 ]; then
  rm -f "$OUT/db-$TS.sql.gz"
  echo "✘ Sauvegarde de la base vide : échec (le conteneur « db » tourne-t-il ?)" >&2
  exit 1
fi
echo "✔ $OUT/db-$TS.sql.gz ($(du -h "$OUT/db-$TS.sql.gz" | cut -f1))"

if [ "${1:-}" = "--files" ]; then
  docker run --rm -v fbm_storage:/data:ro -v "$OUT":/out alpine tar czf "/out/files-$TS.tgz" -C /data .
  echo "✔ $OUT/files-$TS.tgz ($(du -h "$OUT/files-$TS.tgz" | cut -f1))"
fi
find "$OUT" -name 'db-*.sql.gz' -mtime +14 -delete
find "$OUT" -name 'files-*.tgz' -mtime +30 -delete
