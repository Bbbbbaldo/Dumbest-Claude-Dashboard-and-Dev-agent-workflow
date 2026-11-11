---
name: task
description: Esegue una issue GitHub da operaio — test che fallisce, implementazione minima, PR verso il branch del piano, revisione indipendente, aggiornamento della documentazione. Usala quando l'utente dice /task <numero issue>, oppure /task con un log d'errore per un fix piccolo.
---

# /task — un'issue, una PR

Sei un operaio. Fai **una** cosa: l'issue che ti è stata data. Il merge
non lo fai tu: lo decide una persona con la CI verde, prima nel branch del
piano, poi il piano intero sul branch principale.

## 0. Dove sei e quali sono le regole

- Devi essere in un worktree, non nel checkout principale:
  `git rev-parse --git-dir` deve contenere `/worktrees/`. Se no, fermati e
  di' all'utente di lanciare `claude --worktree issue-<n>`.
- Leggi la sezione `## Flusso di lavoro` del `CLAUDE.md` del progetto. Ti servono:
  - **branch principale** (default `main`) e **piano per i fix piccoli** (default `piano/fix-vari`);
  - **preparazione del worktree** (dipendenze, `.env`): se c'è uno script, lancialo;
  - **comandi di test**: rapidi (unit, typecheck), integrazione (e come
    isolarli dagli altri worktree), suite lente da lanciare solo se tocchi certe aree;
  - **convenzione dei commit**.

  Se la sezione manca, ricava i comandi dal `README`, dai file di
  configurazione (`package.json`, `pyproject.toml`, `Makefile`…) e dalla CI,
  e dillo all'utente nel resoconto finale.

## 1. L'issue

- Con un numero: `gh issue view <n>`. È la tua unica specifica.
- Con un log al posto del numero (fix piccolo): scrivi prima l'issue con lo
  stesso schema che usa `/pianifica` (Origine, Comportamento atteso, Criterio
  di "fatto", Perimetro, Branch del piano = il piano dei fix piccoli), creala
  con `gh issue create --label task` e usa quel numero. I fix piccoli si
  accumulano lì e vanno sul branch principale quando lo decide chi fa il
  merge, non uno per volta.
  Se non c'è una PR aperta da quel branch (`gh pr list --head piano/fix-vari`),
  crea il branch e la PR in bozza come al punto 5 di `/pianifica`, titolo
  "Piano: fix vari". Se c'è, aggiungi `- [ ] #<n> <titolo>` e `Closes #<n>`
  al suo corpo (`gh pr view --json body`, poi `gh pr edit --body-file -`).

La **base** è il branch nella sezione "Branch del piano" dell'issue
(`piano/<nome>`). Sul branch principale non punta mai una PR di task.
Porta il worktree sulla base e rinomina il branch:

```bash
git fetch origin <base>
git branch -m <feat|fix>/<n>-<due-tre-parole>
git reset --keep origin/<base>
```

Se l'issue "Dipende da #m": la PR di #m deve essere già nel branch del piano
(`git log origin/<base> --oneline -i -E --grep "closes #m([^0-9]|$)"` non vuoto). Se non c'è,
fermati e dillo all'utente.

Leggi la documentazione del progetto **solo** se l'issue non basta per
decidere: le regole che servono le ha già copiate il pianificatore.

## 2. Prima il test, rosso

Scrivi il test che verifica il criterio di "fatto" e lancialo: **deve
fallire**, per il motivo giusto. Un test che passa già non prova niente.

Usa i comandi del `CLAUDE.md`. I test di integrazione vanno lanciati **solo
su risorse tue** (database, porte, cartelle): quelle condivise le
svuoteresti a un altro operaio che lavora in parallelo.

## 3. Implementazione minima

Il minimo che fa diventare verde il test, dentro il perimetro dell'issue.

**Fuori perimetro non si sistema niente.** Se noti un bug, un'incoerenza o
codice sospetto fuori perimetro:
1. `gh issue list --search "<parole chiave>"`: se esiste, aggiungi un commento lì.
2. Se non esiste: `gh issue create --label da-valutare` con dove, cosa succede,
   cosa ti aspetteresti, e "Trovato durante #<n>".
3. Vai avanti con il tuo task.

Se il problema fuori perimetro **blocca** il task, fermati: commenta l'issue
(`gh issue comment <n>`) spiegando cosa blocca, e dillo all'utente.

## 4. Verifica

- Il test del punto 2 adesso è verde.
- I controlli rapidi del progetto sono verdi.
- Se hai toccato codice coperto da test di integrazione, lanciali sulle tue risorse.
- Se il `CLAUDE.md` indica suite lente per l'area che hai toccato, lanciale
  qui: spesso sulla PR la CI fa solo il controllo rapido, e un rosso
  scoperto dopo blocca tutto il piano.

## 5. Commit e PR

- Commit secondo la convenzione del progetto (default: `feat: …` / `fix: …`),
  corpo con il perché e `Closes #<n>`.
- `git push -u origin HEAD`
- `gh pr create --base <base> --body-file -` con: cosa cambia (funzionale),
  come è verificato, issue `da-valutare` aperte durante il lavoro. Se cambi
  una regola, una soglia o una formula, scrivi il **perché**: serve al documentatore.
- La documentazione non la scrivi tu: la aggiorna il `documentatore` al punto 7.

## 6. Revisione

Lancia il subagente `revisore` con il numero della PR e dell'issue. Se
l'esito è DA CORREGGERE: correggi i 🔴, valuta i 🟡, nuovo commit, push.
Al massimo due giri; poi lascia la decisione all'utente.

## 7. Documentazione

Solo con esito "OK per il merge": lancia il subagente `documentatore` con
il numero della PR e dell'issue. Aggiorna la documentazione (o dice che non
serve) e commenta la PR. Se il progetto non ha documentazione da tenere
allineata, salta questo punto.

## 8. Chiudere

- Libera le risorse di test che hai creato.
- All'utente: link della PR (e verso quale base), esito della revisione,
  pagine di documentazione aggiornate, stato dei check (`gh pr checks <pr>`).

Poi fermati. Non fare il merge.
