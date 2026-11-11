# Mio progetto

<!--
Modello della sezione che le skill /pianifica e /task e gli agenti revisore e
documentatore leggono. Copiala nel CLAUDE.md del tuo progetto e adattala:
tutto quello che è specifico del progetto sta qui, non nelle skill.
-->

## Flusso di lavoro

### Branch e merge
- Branch principale: `main`. Ogni merge su `main` va in produzione.
- I piani sono branch `piano/<nome>`; le PR dei task puntano al branch del piano, mai a `main`.
- Fix piccoli senza piano: PR verso `piano/fix-vari`.
- Il merge lo fa solo <nome della persona>. Gli agenti non fanno merge (lo impedisce anche l'hook `comandi-vietati.py`).
- Fuori perimetro non si sistema: si apre un'issue con label `da-valutare`.

### Come si divide il lavoro
- Un task che tocca sia `backend/` sia `frontend/` va spezzato in due.
- Il contratto tra backend e frontend sta in `frontend/src/api/schemas.ts`: se cambia, è un task a sé.

### Preparazione del worktree
`scripts/prepara-worktree.sh` collega dal checkout principale dipendenze e `.env` (lo lancia anche l'hook
SessionStart in `.claude/settings.json`).

### Comandi di test
| Quando | Comando |
|---|---|
| Rapido (lo rifà l'hook di commit) | `cd backend && pytest -q tests/unit` · `cd frontend && npm run typecheck` |
| Integrazione, su database propri | `eval "$(scripts/db-test-worktree.sh <n>)"` poi `pytest tests/integration/<file>` |
| Lento, solo se tocchi `backend/importazione/` | `pytest -q tests/corpus` |

Sulla PR la CI fa solo il controllo rapido; la suite completa gira prima del deploy.

### Commit
Convenzionali in italiano: `feat: …`, `fix: …`, `docs: …`, corpo con il perché e `Closes #<n>`.

### Dove sta la conoscenza
- Documentazione funzionale in `docs/` (oppure: wiki su <dove>, server MCP `<nome>`, strumenti `read_doc`, `search_docs`…).
- Link a una pagina: `docs/<file>.md` (oppure l'URL della wiki).
- Vincolanti solo le pagine marcate `Stato: verificato`; le bozze sono proposte.
- Scrive nella documentazione solo l'agente `documentatore`, dopo l'OK del `revisore`.

### Se tocchi X, leggi Y
| Area di codice | Pagine |
|---|---|
| `backend/importazione/` | `docs/importazione.md`, `docs/storia-delle-regole.md` |
| `backend/calcoli/` | `docs/indicatori.md` |
| `frontend/src/auth/` | `docs/accessi.md` |

### Checklist di revisione
Gli errori tipici di questo progetto, che il `revisore` cerca per primi:
- importi come `float` invece di `Decimal`/stringa;
- query fuori dal modulo che imposta lo schema del cliente;
- messaggi all'utente con termini tecnici.
