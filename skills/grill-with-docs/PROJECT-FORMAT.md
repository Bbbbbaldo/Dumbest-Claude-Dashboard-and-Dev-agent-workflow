# Formato di PROJECT.md

`PROJECT.md` è la **carta fondativa** del progetto: lo strato più stabile della
documentazione. Risponde a *perché questo progetto esiste*, *per chi* e *quali
principi ci guidano*. Cambia di rado — quando cambia, di solito è perché è
cambiata la direzione, non il codice.

Vive nella radice del repository, accanto a `CONTEXT.md`.

## Struttura

```md
# {Nome del progetto}

{Una o due frasi: cos'è questo progetto, in una riga che potresti dire ad alta voce.}

## Perché esiste

{1-3 frasi sul problema che il progetto risolve e perché valeva la pena affrontarlo.}

## Per chi

{Chi sono gli utenti o i destinatari. Sii concreto: un ruolo, non "tutti".}

## Obiettivi

- {Risultato che il progetto punta a raggiungere}
- {Un altro risultato}

## Non obiettivi

- {Qualcosa che il progetto deliberatamente NON fa}
- {Un'altra cosa fuori ambito di proposito}

## Principi

- **{Principio}**: {una frase su come orienta le decisioni quotidiane}
- **{Principio}**: {una frase}
```

## Regole

- **I non obiettivi valgono quanto gli obiettivi.** Dire esplicitamente cosa il
  progetto NON farà evita derive di ambito e impedisce a chi legge — persona o
  IA — di "aggiungere" funzionalità mai volute. Non saltare questa sezione.
- **I principi devono essere azionabili.** Un principio è utile solo se aiuta a
  scegliere tra due opzioni reali. "Scriviamo buon codice" non è un principio;
  "preferiamo la semplicità leggibile all'astrazione precoce" lo è.
- **Mantieni la stabilità.** Se ti accorgi di aggiornare `PROJECT.md` di
  continuo, probabilmente ci stai mettendo dentro contenuti che appartengono
  altrove (vedi sotto). La carta deve poter restare ferma per mesi.
- **Sii breve.** Una pagina basta. La carta è una bussola, non un manuale.

## Cosa va dove

`PROJECT.md` è uno dei quattro strati documentali. Ognuno cattura ciò che gli
altri non possono recuperare. Prima di scrivere qualcosa, chiediti di quale
strato fa parte:

| Strato          | Risponde a            | Stabilità          | File / luogo            |
| --------------- | --------------------- | ------------------ | ----------------------- |
| **Carta**       | Perché / per chi      | Quasi immutabile   | `PROJECT.md`            |
| **Linguaggio**  | Cosa significano i termini | Si affina nel tempo | `CONTEXT.md`         |
| **Decisioni**   | Perché abbiamo scelto così | Append-only    | `docs/adr/`             |
| **Lavoro vivo** | Cosa / quando         | Alta rotazione     | issue, PRD, board       |

Guardie pratiche:

- **Stato, roadmap, todo, "prossimi passi"** → NON in `PROJECT.md`. Quelli sono
  lavoro vivo: vanno nelle issue o nella board. La carta dice dove si va, non a
  che punto siamo.
- **Definizioni di termini di dominio** → in `CONTEXT.md`, non nella carta. Se ti
  ritrovi a definire una parola, hai sbagliato file.
- **Una scelta tecnologica o architetturale con un compromesso** → è un ADR, non
  un principio. I principi sono durevoli; le decisioni sono datate e specifiche.
- **Un obiettivo che in realtà è una funzionalità** ("aggiungere l'export PDF")
  → è lavoro vivo. Un obiettivo della carta è un risultato ("gli utenti possono
  portare fuori i propri dati"), non un ticket.

## Creazione pigra

Come per `CONTEXT.md` e gli ADR, crea `PROJECT.md` solo quando hai qualcosa di
reale da scrivere. Il primo momento utile è di solito quando emergono il primo
obiettivo o il primo non obiettivo chiari durante una sessione di
interrogazione. Non riempire un modello vuoto per il gusto di averlo.

<!--
File originale aggiunto all'adattamento italiano della skill "grill-with-docs".
Lo strato "carta fondativa" (PROJECT.md) non fa parte della skill originale di
Matt Pocock (mattpocock/skills): è un'estensione di questo repository. La skill
su cui si innesta resta distribuita con licenza MIT — vedi CREDITS.md nella
radice del repository.
-->
