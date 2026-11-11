#!/bin/bash
# Hook di Claude Code: manda l'evento al collettore del cruscotto.
# Regola: non bloccare e non rompere mai la sessione. Invio in background, timeout breve, uscita sempre 0.
#
# Configurazione (facoltativa, per una macchina remota):
#   CRUSCOTTO_URL         indirizzo del collettore (default http://127.0.0.1:4317)
#   CRUSCOTTO_TOKEN_FILE  file con il token condiviso (default ~/.config/cruscotto-claude/token)

URL="${CRUSCOTTO_URL:-http://127.0.0.1:4317}"
TOKEN_FILE="${CRUSCOTTO_TOKEN_FILE:-$HOME/.config/cruscotto-claude/token}"

corpo="$(cat)"
token="$(cat "$TOKEN_FILE" 2>/dev/null)"
[ -z "$token" ] && exit 0

# pid del processo claude (l'hook può girare dentro una shell intermedia): serve al collettore
# per capire se la sessione è ancora viva quando SessionEnd non arriva (crash, kill)
p=$PPID
for _ in 1 2 3 4; do
  case "$(ps -o comm= -p "$p" 2>/dev/null)" in *claude*) break ;; esac
  p=$(ps -o ppid= -p "$p" 2>/dev/null | tr -d ' ')
  if [ -z "$p" ] || [ "$p" = 1 ]; then p=""; break; fi
done

(
  curl -s -m 2 -o /dev/null -X POST "$URL/api/eventi" \
    -H 'content-type: application/json' \
    -H "x-cruscotto-token: $token" \
    -H "x-cruscotto-host: $(hostname -s)" \
    -H "x-cruscotto-pid: $p" \
    -H "x-cruscotto-origine: ${CLAUDE_CODE_ENTRYPOINT:-}" \
    --data-binary "$corpo"
) >/dev/null 2>&1 &

exit 0
