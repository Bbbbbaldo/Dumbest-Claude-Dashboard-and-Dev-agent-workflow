#!/usr/bin/env bash
# Prepara il worktree di un operaio: collega dal checkout principale
# quello che git non porta con sé (dipendenze, .env, dati di prova).
# Idempotente. Da lanciare dalla radice del worktree; lo lancia anche
# l'hook SessionStart (vedi esempi/settings.json).
#
# Adatta l'elenco in fondo al tuo progetto.
set -euo pipefail

radice=$(git rev-parse --show-toplevel)
principale=$(dirname "$(git rev-parse --path-format=absolute --git-common-dir)")

if [ "$radice" = "$principale" ]; then
  echo "sei nel checkout principale: niente da fare"; exit 0
fi

collega() {  # collega <percorso relativo>
  if [ -e "$principale/$1" ] && [ ! -e "$radice/$1" ]; then
    ln -s "$principale/$1" "$radice/$1"
    echo "  collegato $1"
  fi
}

# --- da adattare ---------------------------------------------------------
collega "frontend/node_modules"
collega "frontend/.env"
collega "backend/.venv"
collega "backend/.env"
# collega "dati-di-prova"      # file grandi o riservati, fuori da git
# -------------------------------------------------------------------------

[ -d "$radice/.githooks" ] && git config core.hooksPath .githooks
echo "✓ worktree pronto"
