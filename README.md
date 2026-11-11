# Dumbest Claude Dashboard and Dev agent workflow

Plugin `flusso-agenti` per Claude Code.


Un flusso di sviluppo con agenti Claude Code, in italiano: da una richiesta scritta a parole a issue atomiche,
eseguite in parallelo da sessioni separate (una per worktree), con test, revisione indipendente e documentazione
allineata. Una persona decide i merge; gli agenti non possono scavalcarla.

Più un **cruscotto** locale che mostra cosa sta facendo ogni sessione, a che punto è ogni piano e dove nasceranno
i conflitti di merge.

Progetto non ufficiale, non affiliato ad Anthropic.

> **English summary** — A Claude Code plugin (Italian-language skills) for an issue-driven, multi-worktree workflow:
> `/pianifica` turns a request into atomic GitHub issues grouped in a "plan" branch and draft PR; `/task <n>` runs
> one issue per worktree (failing test → minimal fix → PR to the plan branch → independent `revisore` review →
> `documentatore` doc update). A hook blocks merges, pushes to the main branch, force pushes and skipped git hooks.
> `cruscotto/` is a local dashboard (Node + optional macOS app) fed by Claude Code hooks: live sessions,
> permission prompts, plan progress, predicted merge conflicts, per-task diffs and an Agent SDK chat.

## Il flusso

```
richiesta ──/pianifica──▶ branch piano/<nome> + PR in bozza verso main
                           issue #1, #2 (parallele), #3 (dopo #1)
                │
                ├─ claude --worktree issue-1  →  /task 1  →  PR verso piano/<nome>
                ├─ claude --worktree issue-2  →  /task 2  →  PR verso piano/<nome>
                │        ogni /task: test rosso → codice minimo → PR → revisore → documentatore
                │
   la persona unisce le PR dei task nel piano, poi il piano su main (un deploy per piano)
```

| Pezzo | Cosa fa |
|---|---|
| `skills/pianifica` | Legge documentazione e codice, spezza la richiesta in task atomici senza file in comune tra task paralleli, chiede l'approvazione, crea branch del piano, issue e PR in bozza. Non scrive codice. |
| `skills/task` | Un'issue, una PR: test che fallisce, implementazione minima, niente fuori perimetro (si apre un'issue `da-valutare`), PR verso il branch del piano, revisione, documentazione. Non fa merge. |
| `agents/revisore` | Contesto pulito: rilegge la diff cercando fuori perimetro, regressioni, test che non provano niente. |
| `agents/documentatore` | Dopo l'OK del revisore, aggiorna la documentazione del progetto (cartella `docs/`, wiki o knowledge base via MCP). |
| `skills/grill-me`, `skills/grill-with-docs` | Interrogano chi sviluppa su un piano finché non è chiaro; la seconda aggiorna anche glossario e decisioni. |
| `hooks/comandi-vietati.py` | Rifiuta `gh pr merge`, push sul branch principale, push forzati, salto dei hook git, modifiche alla protezione dei branch. |
| `hooks/cruscotto.sh` | Manda gli eventi di ogni sessione al cruscotto (se è attivo; altrimenti non fa niente). |
| `cruscotto/` | Il cruscotto: vedi [cruscotto/README.md](cruscotto/README.md). |
| `esempi/` | Modello della sezione `## Flusso di lavoro` del CLAUDE.md, script per i worktree, hook di commit. |

## Installazione

Serve [Claude Code](https://docs.claude.com/en/docs/claude-code) e `gh` autenticato.

```
/plugin marketplace add Bbbbbaldo/Dumbest-Claude-Dashboard-and-Dev-agent-workflow
/plugin install flusso-agenti@flusso-agenti
```

Le skill si usano come `/pianifica` e `/task` (o `/flusso-agenti:task` se un'altra skill ha lo stesso nome).

## Adattarlo al tuo progetto

Le skill sono generiche: tutto quello che è specifico di un progetto sta nella sezione **`## Flusso di lavoro`**
del suo `CLAUDE.md`. Parti da [esempi/CLAUDE.md](esempi/CLAUDE.md):

- branch principale, prefisso dei piani, chi fa il merge;
- come preparare un worktree (dipendenze, `.env`) e i comandi di test: rapidi, integrazione isolata per worktree, suite lente;
- dove sta la documentazione e la tabella "Se tocchi X, leggi Y";
- la checklist di revisione con gli errori tipici del progetto.

Senza quella sezione le skill usano i default (`main`, `piano/`) e ricavano i comandi da README, configurazione e CI.

Facoltativo, in `esempi/`:
- `scripts/prepara-worktree.sh` + `settings.json`: collega `node_modules`, `.venv`, `.env` in ogni worktree nuovo;
- `scripts/db-test-worktree.sh`: un database di test per worktree, così i test di integrazione in parallelo non si svuotano le tabelle;
- `githooks/commit-msg`: controllo rapido sui commit `feat:`/`fix:`.

### Il hook che blocca i comandi

È attivo in tutti i progetti in cui il plugin è abilitato. Si configura con variabili d'ambiente (per esempio in
`"env"` di `.claude/settings.json`):

| Variabile | Default | |
|---|---|---|
| `FLUSSO_RAMI_PROTETTI` | `main master` | branch su cui non si fa push diretto |
| `FLUSSO_COMANDI_VIETATI` | `1` | `0` lo disattiva |

## Il cruscotto

```bash
cd cruscotto && npm ci && cp config.example.json config.json && npm start   # http://127.0.0.1:4317
```

Con il plugin installato gli eventi delle sessioni arrivano da soli. Dettagli, app per macOS e privacy in
[cruscotto/README.md](cruscotto/README.md).

## Licenza

MIT, vedi [LICENSE](LICENSE). `grill-me` e `grill-with-docs` derivano da
[mattpocock/skills](https://github.com/mattpocock/skills) (MIT): vedi [CREDITS.md](CREDITS.md).
