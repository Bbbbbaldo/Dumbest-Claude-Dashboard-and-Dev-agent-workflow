#!/usr/bin/env bash
# Database di test propri di un operaio (PostgreSQL), per lanciare i test di
# integrazione senza svuotare le tabelle di chi lavora in parallelo in un
# altro worktree.
#
# Uso:   eval "$(scripts/db-test-worktree.sh 42)"     # 42 = numero dell'issue
# Poi:   i test di integrazione leggono TEST_DATABASE_URL
# Fine:  scripts/db-test-worktree.sh 42 --elimina
#
# Adatta il nome del database, le migrazioni e le variabili al tuo progetto.
set -euo pipefail

n="${1:?serve il numero della issue}"
db="mioprogetto_test_i$n"

if [ "${2:-}" = "--elimina" ]; then
  dropdb --if-exists "$db"
  echo "# eliminato $db" >&2; exit 0
fi

if ! psql -lqt | cut -d'|' -f1 | grep -qw "$db"; then
  createdb "$db"
  # qui le migrazioni, per esempio:
  # (cd "$(git rev-parse --show-toplevel)/backend" && DATABASE_URL=... alembic upgrade head >/dev/null)
fi

echo "export TEST_DATABASE_URL=postgresql://localhost:5432/$db"
