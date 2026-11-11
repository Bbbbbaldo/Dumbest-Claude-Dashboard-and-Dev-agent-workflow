# Cruscotto agenti

Pagina locale (e app per macOS) che mostra, per tutti i progetti:

- le sessioni Claude Code vive (CLI, VS Code, app desktop): se lavorano, se **chiedono un permesso**, se sono ferme, da quanto, ultima azione;
- i **piani**: PR aperte con una checklist di issue, con lo stato di ogni task
  (fatto, PR da unire, in corso, chiede permesso, aspetta te, pronto, bloccato) e la sessione che ci lavora;
- i **conflitti di merge**, anche prima che nascano: task che andrebbero in conflitto con il piano o tra loro;
- le sessioni da chiudere (issue chiusa o PR già unita, processo ancora aperto);
- issue e PR aperte fuori dai piani;
- una chat con Claude Code nella radice di un repo, con i permessi approvati dalla pagina.

Progetto non ufficiale, non affiliato ad Anthropic.

## Requisiti

- macOS o Linux (l'app e l'avvio delle sessioni nel Terminale sono solo per macOS)
- Node ≥ 22.5 (`node:sqlite`), git ≥ 2.38, `gh` autenticato
- Claude Code installato e con login fatto (la chat usa lo stesso `claude`)

```bash
cd cruscotto
npm ci
cp config.example.json config.json   # e adattalo
npm start                             # http://127.0.0.1:4317
```

## Hook: lo stato arriva dalle sessioni

Ogni sessione Claude Code manda i suoi eventi al cruscotto con `hooks/cruscotto.sh`.

- **Con il plugin** (`/plugin install flusso-agenti@flusso-agenti`, vedi il README principale) gli hook sono già
  registrati: niente da fare.
- **Senza il plugin**: registra `hooks/cruscotto.sh` in `~/.claude/settings.json` come hook `async` su
  SessionStart, UserPromptSubmit, PreToolUse, Notification (matcher `permission_prompt|idle_prompt`), Stop e
  SessionEnd. Il blocco da copiare è in `../hooks/hooks.json` (sostituisci `${CLAUDE_PLUGIN_ROOT}` con il percorso
  del repo).

Lo script non blocca mai la sessione: invio in background, timeout 2 s, uscita sempre 0. Se il cruscotto non è
mai stato avviato (manca il token) non fa niente.

| Evento | Stato |
|---|---|
| UserPromptSubmit, PreToolUse | lavora (con richiesta e tool in uso) |
| Notification `permission_prompt` | chiede un permesso |
| Stop, Notification `idle_prompt` | ferma |
| SessionEnd (o processo locale sparito) | chiusa |

- `POST /api/eventi`, autenticato con il token in `~/.config/cruscotto-claude/token` (creato dal server al primo
  avvio, permessi 600).
- Eventi e stato in `dati/eventi.sqlite` (eventi tenuti 14 giorni).
- Per le sessioni che non mandano eventi (aperte prima di installare gli hook) resta come riserva il registro
  interno `~/.claude/sessions`; `"leggiRegistroInterno": false` in config lo spegne. Il contatore "hook N/M" in alto
  dice quante sessioni arrivano dagli hook.
- Da un'altra macchina: stesso script con `CRUSCOTTO_URL` (e lo stesso token in `CRUSCOTTO_TOKEN_FILE`).

**Privacy**: `dati/` contiene le richieste che scrivi, i comandi eseguiti e le chat del cruscotto. Resta sul tuo
computer ed è esclusa da git. Il server ascolta solo su `127.0.0.1` e rifiuta richieste con un `Host` diverso.

## App per macOS

`app/` contiene un'app SwiftUI con la stessa interfaccia, più:

- avvio e sorveglianza del server: lo lancia da sola (con il PATH della shell di login) e lo rilancia se cade;
  se un server è già in ascolto sulla porta, usa quello;
- icona nella barra dei menu con permessi in attesa o sessioni al lavoro, e menu rapido (permessi, conflitti,
  sessioni al lavoro, riavvio del server, log, avvio al login);
- notifiche: permesso richiesto, risposta di una chat pronta, sessione passata da "lavora" a "ferma", conflitto nuovo;
- badge sull'icona del Dock con i permessi in attesa; chiudere la finestra non chiude l'app.

```bash
app/build.sh             # crea app/build/Cruscotto agenti.app
app/build.sh --installa  # e la copia in ~/Applications
NOME_APP="Cruscotto" BUNDLE_ID="com.esempio.cruscotto" app/build.sh --installa
```

L'app avvia il server dalla cartella che contiene `app/`: se sposti il repo, ricompila. Firmata ad-hoc: va bene
sul computer dove la compili, non per distribuirla. Log del server: `~/Library/Logs/CruscottoClaude/server.log`.

## Da dove legge

| Dato | Fonte |
|---|---|
| Sessioni vive | eventi degli hook; riserva: `~/.claude/sessions/<pid>.json` (solo se il processo esiste ancora) |
| Ultima azione | eventi degli hook e ultime righe del transcript `~/.claude/projects/<cartella>/<sessionId>.jsonl` |
| Repo | radice git del `cwd` di ogni sessione (i worktree finiscono nel repo principale) + `repos` in config |
| Issue di una sessione | nome del worktree (`issue-217`) o numero nel branch (`feat/217-...`) |
| Piani | PR aperte con branch `piano/*` oppure con almeno 2 righe `- [ ] #n` nel corpo |
| Task di un piano | righe `- [ ] #n` del piano; PR dei task = PR con base il branch del piano |
| Dipendenze | `(dopo #n)` nella riga della checklist, sezione `## Dipende da` dell'issue |

È il formato che producono le skill `/pianifica` e `/task` di questo repo, ma funziona con qualunque PR che abbia
una checklist di issue.

GitHub si rilegge ogni 30 s (bottone "Ricarica GitHub" per subito); sessioni e transcript a ogni aggiornamento
della pagina (3 s).

`~/.claude/sessions` e i transcript sono formati interni di Claude Code: se un aggiornamento li cambia, si
corregge `leggiSessioni()` / `ultimaAttivita()` in `server.mjs`.

## Configurazione

`config.json` in questa cartella (o `~/.config/cruscotto-claude/config.json`), modello in `config.example.json`:

- `repos`: progetti da mostrare anche senza sessioni aperte.
- `nascondiRepo`: progetti da non mostrare mai.
- `prefissiPiano`, `minTaskPiano`: cosa rende una PR un piano.
- `comandoAvvio`: per nome cartella o percorso del repo (`{n}` = numero issue). Sui task non fatti e senza sessione
  compaiono "▶ Avvia sessione" e "copia comando".
- `terminale`: `"Terminal"` (default) o `"iTerm"`, dove si apre la sessione avviata dal cruscotto.

## Progetti seguiti

Il menu "Tutti i progetti ▾" in alto sceglie quali progetti seguire. Con una scelta:

- il cruscotto mostra solo quei progetti, e i contatori contano solo le loro sessioni;
- l'app manda notifiche, badge e voci di menu solo per le loro sessioni e chat;
- una sessione la cui cartella non è più un repo git (per esempio un worktree cancellato) conta per il progetto che
  contiene la cartella.

Una sessione singola si silenzia con 🔔 sulla sua scheda (clic di nuovo per riattivarla): resta visibile, ma
l'app non manda notifiche né badge per lei. Nel menu dei progetti c'è anche "Notifiche solo per le sessioni dei
task", per ignorare le sessioni non legate a un'issue.

La scelta sta in `dati/preferenze.json` (`GET`/`POST /api/preferenze`: `seguiti`, `null` = tutti; `silenziate`; `soloTask`).

## Modifiche di un task

"Vedi modifiche" (su ogni task con worktree o PR) apre un pannello con:

- commit del worktree rispetto al branch del piano (`origin/piano/...`, dal merge-base);
- modifiche non ancora committate e file nuovi non aggiunti a git;
- se il worktree non c'è più o non ha differenze (lavoro già unito): il diff della PR (`gh pr diff`).

Il pannello si rilegge ogni 10 s finché è aperto, così si vede la sessione che scrive.

## Conflitti di merge

Un task, un piano o una PR in conflitto ha il segno rosso "conflitto"; in alto c'è il contatore "N in conflitto".
Sotto il task, un riquadro dice di che conflitto si tratta e quali file tocca:

| Conflitto | Come si rileva |
|---|---|
| La PR non si può unire | GitHub: `mergeable = CONFLICTING` delle PR aperte (task, piano verso `main`, PR fuori piano) |
| Merge, rebase o cherry-pick a metà | nel worktree: `MERGE_HEAD` / `rebase-merge` / `CHERRY_PICK_HEAD` e file non risolti (`git diff --diff-filter=U`) |
| Il task andrebbe in conflitto con il piano | prova di merge del commit del worktree con `origin/piano/...` (`git merge-tree --write-tree`, non tocca file né indice) |
| Due task del piano si pestano i piedi | prova di merge tra i commit di due worktree: il secondo che si unisce al piano avrà conflitti |

- Le prove di merge si fanno solo per i task non ancora fatti e si ricalcolano solo quando cambia un commit.
- Il confronto locale usa `origin/piano/...` dell'ultimo `git fetch`: il cruscotto non fa fetch da solo.
- GitHub calcola `mergeable` in ritardo: subito dopo un push può risultare sconosciuto per qualche secondo.
- Serve git ≥ 2.38.

L'app mostra i conflitti nel menu (clic = apre la PR) e manda una notifica quando ne compare uno nuovo.

## Chat

"💬 Chat" in alto, o "💬 Nuova chat qui" accanto a un repo, apre una chat con Claude Code nella radice del repo
(Agent SDK, `chat.mjs`). Carica CLAUDE.md, skill, MCP e hook del progetto come la CLI: si usa per `/pianifica`
e per modificare issue, piani e dipendenze. Usa il `claude` installato (stesso login e versione).

- **Permessi**: modalità `default`. Ogni azione che chiederebbe un permesso compare come scheda con
  Consenti / Consenti sempre (per questa chat) / Nega con motivo. Le domande di Claude (AskUserQuestion)
  compaiono come scelte. Il numero di permessi in attesa è sul bottone "Chat" e nel titolo della scheda.
- **Interrompi** ferma il turno; **Termina** chiude il processo Claude della chat. La storia resta in
  `dati/chat/` e al messaggio successivo la conversazione riprende (`resume`), anche dopo un riavvio del server.
- Le sessioni delle chat compaiono nel cruscotto con l'etichetta "chat del cruscotto".

## Avvio di una sessione da un task

"▶ Avvia sessione" apre una finestra del terminale ed esegue `cd <repo> && <comandoAvvio>`.
La prima volta macOS chiede di consentire a `node` di controllare il Terminale (Impostazioni → Privacy → Automazione).

Protezioni dell'endpoint `POST /api/avvia`: accetta solo richieste dalla pagina del cruscotto (`Origin` + header
`x-cruscotto`), il comando viene solo da `config.json` (dalla pagina passano repo e numero, validati), rifiuta se c'è
già una sessione viva su quell'issue o se è stata avviata negli ultimi 30 s. Sui task bloccati chiede conferma.

Il server ascolta solo su `127.0.0.1` e rifiuta richieste con un `Host` diverso: la pagina contiene pezzi dei transcript.
