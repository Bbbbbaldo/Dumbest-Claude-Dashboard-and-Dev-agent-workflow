#!/usr/bin/env python3
"""PreToolUse (Bash): blocca i comandi che scavalcano i cancelli.

Gli operai lavorano su un branch e aprono una PR; il merge lo decide
una persona, con la CI verde. Un agente che fa merge, spinge sul branch
principale o salta i hook toglie l'unico controllo che non dipende dalla
sua disciplina. Exit 2 = comando rifiutato, il messaggio torna all'agente.

Configurazione (variabili d'ambiente, per esempio in "env" di settings.json):
  FLUSSO_RAMI_PROTETTI   branch su cui non si fa push diretto (default: "main master")
  FLUSSO_COMANDI_VIETATI "0" disattiva il controllo
"""
import json
import os
import re
import sys

if os.environ.get("FLUSSO_COMANDI_VIETATI", "1") == "0":
    sys.exit(0)

comando = json.load(sys.stdin).get("tool_input", {}).get("command", "")
rami = [r for r in os.environ.get("FLUSSO_RAMI_PROTETTI", "main master").split() if r]
alternativa = "|".join(re.escape(r) for r in rami) or r"(?!)"

VIETATI = [
    (r"--no-verify\b", "i hook non si saltano: se un test è rosso, sistemalo o fermati e segnalalo"),
    (r"\bgh\s+pr\s+merge\b", "il merge lo fa una persona, dopo la CI verde"),
    (rf"\bgit\s+push\b.*(\s|:)({alternativa})(\s|$)", "sul branch principale si arriva solo con una PR"),
    (r"\bgit\s+push\b.*(--force\b|--force-with-lease\b|\s-f\b)", "niente push forzati: crea un commit nuovo"),
    (r"\bgh\s+api\b.*\bprotection\b", "la protezione dei branch si cambia a mano"),
]

for schema, motivo in VIETATI:
    if re.search(schema, comando):
        print(f"Comando rifiutato: {motivo}.", file=sys.stderr)
        sys.exit(2)
