# Formato di CONTEXT.md

## Struttura

```md
# {Nome del contesto}

{Una o due frasi che descrivono cos'è questo contesto e perché esiste.}

## Linguaggio

**Ordine**:
{Una o due frasi che descrivono il termine}
_Da evitare_: Acquisto, transazione

**Fattura**:
Una richiesta di pagamento inviata a un cliente dopo la consegna.
_Da evitare_: Conto, richiesta di pagamento

**Cliente**:
Una persona o un'organizzazione che effettua ordini.
_Da evitare_: Committente, acquirente, account
```

## Regole

- **Sii deciso.** Quando esistono più parole per lo stesso concetto, scegli la migliore ed elenca le altre sotto `_Da evitare_`.
- **Mantieni le definizioni essenziali.** Una o due frasi al massimo. Definisci cosa È, non cosa fa.
- **Includi solo i termini specifici del contesto di questo progetto.** I concetti generali di programmazione (timeout, tipi di errore, pattern di utilità) non vanno inclusi anche se il progetto li usa molto. Prima di aggiungere un termine, chiediti: è un concetto unico di questo contesto, o un concetto generale di programmazione? Solo il primo va incluso.
- **Raggruppa i termini sotto sottotitoli** quando emergono cluster naturali. Se tutti i termini appartengono a un'unica area coesa, va bene anche un elenco piatto.

## Repository a contesto singolo o multiplo

**Contesto singolo (la maggior parte dei repository):** Un solo `CONTEXT.md` nella radice del repository.

**Contesti multipli:** Un `CONTEXT-MAP.md` nella radice del repository elenca i contesti, dove si trovano e come sono in relazione tra loro:

```md
# Mappa dei contesti

## Contesti

- [Ordini](./src/ordini/CONTEXT.md) — riceve e tiene traccia degli ordini dei clienti
- [Fatturazione](./src/fatturazione/CONTEXT.md) — genera fatture ed elabora i pagamenti
- [Evasione](./src/evasione/CONTEXT.md) — gestisce il prelievo a magazzino e la spedizione

## Relazioni

- **Ordini → Evasione**: Ordini emette eventi `OrderPlaced`; Evasione li consuma per avviare il prelievo
- **Evasione → Fatturazione**: Evasione emette eventi `ShipmentDispatched`; Fatturazione li consuma per generare le fatture
- **Ordini ↔ Fatturazione**: Tipi condivisi per `CustomerId` e `Money`
```

La skill deduce quale struttura si applica:

- Se esiste `CONTEXT-MAP.md`, leggilo per trovare i contesti
- Se esiste solo un `CONTEXT.md` nella radice, contesto singolo
- Se non esiste nessuno dei due, crea un `CONTEXT.md` nella radice con pigrizia, quando il primo termine viene definito

Quando esistono più contesti, deduci a quale si riferisce l'argomento corrente. Se non è chiaro, chiedi.

<!--
Adattamento e traduzione in italiano di un file della skill "grill-with-docs"
di Matt Pocock (mattpocock/skills), distribuita con licenza MIT. Vedi CREDITS.md
nella radice del repository per la nota di copyright e la licenza complete.
-->
