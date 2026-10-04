#!/usr/bin/env bash
# Stops the private mc-pace test stack and deletes its containers and volumes.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
supabase stop --workdir "$here" --no-backup
rm -f "$here/.env.local"
