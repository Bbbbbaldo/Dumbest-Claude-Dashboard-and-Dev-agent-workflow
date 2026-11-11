# Formato degli ADR

Gli ADR risiedono in `docs/adr/` e usano una numerazione sequenziale: `0001-slug.md`, `0002-slug.md`, ecc.

Crea la cartella `docs/adr/` con pigrizia — solo quando serve il primo ADR.

## Modello

```md
# {Titolo breve della decisione}

{1-3 frasi: qual è il contesto, cosa abbiamo deciso e perché.}
```

Tutto qui. Un ADR può essere un singolo paragrafo. Il valore sta nel registrare *che* una decisione è stata presa e *perché* — non nel compilare delle sezioni.

## Sezioni opzionali

Includile solo quando aggiungono valore reale. La maggior parte degli ADR non ne avrà bisogno.

- Frontmatter **Stato** (`proposto | accettato | deprecato | sostituito da ADR-NNNN`) — utile quando le decisioni vengono riviste
- **Opzioni considerate** — solo quando le alternative scartate vale la pena ricordarle
- **Conseguenze** — solo quando vanno evidenziati effetti collaterali non ovvi

## Numerazione

Scorri `docs/adr/` per trovare il numero più alto esistente e incrementalo di uno.

## Quando proporre un ADR

Devono essere vere tutte e tre queste condizioni:

1. **Difficile da invertire** — il costo di cambiare idea in seguito è significativo
2. **Sorprendente senza contesto** — chi leggerà in futuro guarderà il codice e si chiederà "perché diavolo l'hanno fatto così?"
3. **Il risultato di un vero compromesso** — c'erano alternative reali e ne hai scelta una per motivi specifici

Se una decisione è facile da invertire, salta l'ADR — tanto la invertirai. Se non è sorprendente, nessuno si chiederà il perché. Se non c'era una vera alternativa, non c'è nulla da registrare oltre a "abbiamo fatto la cosa ovvia".

### Cosa qualifica

- **Forma architetturale.** "Usiamo un monorepo." "Il write model è event-sourced, il read model è proiettato in Postgres."
- **Pattern di integrazione tra contesti.** "Ordini e Fatturazione comunicano tramite eventi di dominio, non HTTP sincrono."
- **Scelte tecnologiche che comportano lock-in.** Database, message bus, provider di autenticazione, target di deployment. Non ogni libreria — solo quelle che richiederebbero un trimestre per essere sostituite.
- **Decisioni su confini e ambito.** "I dati del Cliente sono di proprietà del contesto Cliente; gli altri contesti li referenziano solo tramite ID." I no espliciti valgono quanto i sì.
- **Deviazioni deliberate dal percorso ovvio.** "Usiamo SQL scritto a mano invece di un ORM perché X." Qualunque cosa in cui un lettore ragionevole presumerebbe il contrario. Queste impediscono al prossimo sviluppatore di "sistemare" qualcosa che era deliberato.
- **Vincoli non visibili nel codice.** "Non possiamo usare AWS per requisiti di conformità." "I tempi di risposta devono restare sotto i 200ms per il contratto con l'API del partner."
- **Alternative scartate quando il rifiuto non è ovvio.** Se hai considerato GraphQL e scelto REST per motivi sottili, registralo — altrimenti tra sei mesi qualcuno riproporrà GraphQL.

<!--
Adattamento e traduzione in italiano di un file della skill "grill-with-docs"
di Matt Pocock (mattpocock/skills), distribuita con licenza MIT. Vedi CREDITS.md
nella radice del repository per la nota di copyright e la licenza complete.
-->
