#!/bin/sh
set -eu

if [ "$#" -ne 2 ]; then
  echo "Usage: sh scripts/import-template.sh <dossier-template> <identifiant>" >&2
  exit 2
fi

source_dir=$1
template_id=$2
if [ ! -d "$source_dir" ]; then
  echo "Dossier introuvable: $source_dir" >&2
  exit 2
fi
case "$template_id" in
  ''|[!a-z0-9]*|*[!a-z0-9_-]*) echo "Identifiant invalide: $template_id" >&2; exit 2 ;;
esac
if [ ! -f "$source_dir/template.json" ] || [ ! -f "$source_dir/theme.css" ]; then
  echo "Le dossier doit contenir template.json et theme.css" >&2
  exit 2
fi
if ! grep -Eq "\"id\"[[:space:]]*:[[:space:]]*\"$template_id\"" "$source_dir/template.json"; then
  echo "L’identifiant de template.json doit correspondre à $template_id" >&2
  exit 2
fi

container_id=$(docker compose ps -q aggregator)
if [ -z "$container_id" ]; then
  echo "Démarrez LuCiDoc avec docker compose up -d avant l’import." >&2
  exit 1
fi
docker exec "$container_id" mkdir -p "/templates/$template_id"
docker cp "$source_dir/." "$container_id:/templates/$template_id/"
docker exec "$container_id" chown -R node:node "/templates/$template_id"
echo "Template « $template_id » copié dans le volume persistant. Rechargez l’interface."
