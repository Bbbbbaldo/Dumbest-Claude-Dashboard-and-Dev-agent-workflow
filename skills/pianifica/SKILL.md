---
name: pianifica
description: Trasforma una richiesta funzionale (segnalazione, feat o fix descritti a parole) in issue GitHub atomiche, pronte per /task, raccolte in un branch e in una PR di piano. Legge la documentazione del progetto e il codice, non scrive codice. Usala quando l'utente dice /pianifica o incolla una segnalazione da trasformare in lavoro.
---

# /pianifica — dalla richiesta alle issue

Sei il pianificatore. Il tuo prodotto sono **issue GitHub**, non codice.
Ogni issue verrà eseguita da un operaio (`/task`) in una sessione nuova,
che leggerà **solo l'issue e il codice**: quello che non scrivi nell'issue,
l'operaio non lo sa.

Non modificare file del repo. L'unico branch che crei è quello del piano
(punto 5): le PR dei task puntano lì, il merge sul branch principale lo fa
una persona.

## 0. Le regole del progetto

Leggi la sezione `## Flusso di lavoro` del `CLAUDE.md` del progetto. Ti serve:

- **Branch principale** (default `main`) e **prefisso dei piani** (default `piano/`).
- **Chi fa il merge** (da citare nelle issue).
- **Dove sta la conoscenza** (cartella `docs/`, wiki, server MCP…) e la tabella
  **"Se tocchi X, leggi Y"**, se c'è.
- **Come si divide il lavoro** (per esempio: un task non tocca sia backend sia frontend).

Se la sezione manca, usa i default, leggi il `README` e la cartella `docs/`
se esistono, e alla fine suggerisci all'utente di aggiungere la sezione
(c'è un modello in `esempi/CLAUDE.md` del plugin).

## 1. Capire la richiesta

L'input è testo incollato dall'utente (spesso da un collaboratore, in
linguaggio funzionale) o un link. Se manca qualcosa di essenziale per
decidere *cosa* deve succedere — non *come* — fai **una** domanda e aspetta.

Cerca issue già aperte sullo stesso tema: `gh issue list --search "<parole chiave>" --state all`.

## 2. Conoscenza: la legge il pianificatore

Dalla tabella "Se tocchi X, leggi Y" individua l'area e leggi le pagine
indicate, con lo strumento che il `CLAUDE.md` indica. Se la documentazione
distingue pagine verificate e bozze, sono vincolanti solo le verificate.
Leggi il codice quanto basta per sapere quali file toccare.

Estrai le **regole che l'operaio non deve violare** (soglie, formati,
eccezioni, decisioni passate con il loro perché): andranno copiate
nell'issue, con il link alla pagina. L'operaio non rilegge la documentazione:
quello che gli serve deve stare nell'issue.

## 3. Spezzare in task atomici

Un task = una PR = un comportamento verificabile. Regole:

- Si fa il merge di ogni task da solo senza rompere niente (eventualmente dietro le dipendenze dichiarate).
- Un task che tocca due parti separate del sistema (per esempio backend e
  frontend) va spezzato, se le due metà hanno senso separate.
- Se servono più di ~5 task, la richiesta è troppo grande: proponi all'utente di tagliarla.
- Un fix con log ed errore chiari è un task solo.
- **Niente file in comune tra task paralleli.** Due task senza dipendenza
  tra loro vengono lanciati insieme, in worktree separati: se i loro
  "Da toccare" condividono un file, al merge la seconda PR va in conflitto.
  Confronta i perimetri dei task nuovi tra loro **e** con quelli delle issue
  `task` già aperte (`gh issue list --label task --state open`, poi
  `gh issue view <n>`). Se si sovrappongono: dichiara la dipendenza
  ("Dipende da #n") oppure accorpa i due task.

## 4. Bozza all'utente

Mostra all'utente l'elenco dei task (titolo + criterio di "fatto" in una
riga ciascuno, più le dipendenze e quali si possono lanciare in parallelo) e
**aspetta l'approvazione** prima di creare le issue.

## 5. Branch del piano e issue

Se le etichette `task` e `da-valutare` non esistono, creale
(`gh label create task`, `gh label create da-valutare`).

Nome: `<prefisso>` + due-quattro parole (minuscole, trattini), per esempio
`piano/esportazione-csv`. Il branch parte dal branch principale con un commit
vuoto, senza toccare il checkout in cui sei: serve perché GitHub non apre una
PR senza differenze.

```bash
git fetch origin <principale>
sha=$(git commit-tree "origin/<principale>^{tree}" -p origin/<principale> -m "chore: avvio piano <nome>")
git push origin "$sha:refs/heads/piano/<nome>"
```

Poi, per ogni task approvato: `gh issue create --label task --title "..." --body-file -` con questo corpo:

```markdown
## Origine
<da dove arriva: "Segnalazione '<titolo>' di <nome>" oppure "Richiesta di <chi>">

## Comportamento atteso
<funzionale, dal punto di vista di chi usa il prodotto>

## Criterio di "fatto"
<verificabile da un test: "dato l'input X, il risultato Y vale Z"; "un utente senza permesso P riceve 403 su /...">

## Perimetro
- Da toccare: <file/aree>
- **Fuori perimetro**: <aree vicine da non modificare; problemi lì → issue `da-valutare`>

## Regole da rispettare (dalla documentazione)
- <regola> — [<pagina>](<link>)

## Cambia un comportamento documentato?
<No | Sì: pagina <link> (la aggiorna il `documentatore` a fine task)>

## Dipende da
<#n o "niente">

## Branch del piano
`piano/<nome>` — il worktree parte da qui e la PR punta qui, non al branch principale.
```

Le issue da più task si citano a vicenda in "Dipende da".

Infine la PR del piano, in bozza:
`gh pr create --draft --base <principale> --head piano/<nome> --title "Piano: <titolo>" --body-file -`

```markdown
## Obiettivo
<la richiesta in due righe, con l'origine>

## Task
- [ ] #<n> <titolo>
- [ ] #<m> <titolo> (dopo #<n>)
...

Closes #<n>, closes #<m>, ...
```

I task si chiudono quando il piano arriva sul branch principale, non al
merge della loro PR nel branch del piano. Il formato `- [ ] #n` e
`(dopo #n)` è quello che legge il cruscotto delle sessioni.

## 6. Chiudere

Rispondi con il link della PR del piano, l'elenco delle issue create e, per
ognuna senza dipendenze aperte, il comando da lanciare (si possono lanciare
insieme). Quelle con dipendenze si lanciano solo dopo il merge, nel branch
del piano, della PR da cui dipendono: il worktree parte da `piano/<nome>`.

```
claude --worktree issue-<n>    poi:  /task <n>
```

Poi fermati.
