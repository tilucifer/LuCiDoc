#!/bin/sh
set -eu

mkdir -p "${DATA_ROOT:-/data}/sites" "${DATA_ROOT:-/data}/work" "${TEMPLATE_ROOT:-/templates}"
exec node /app/src/server.js
