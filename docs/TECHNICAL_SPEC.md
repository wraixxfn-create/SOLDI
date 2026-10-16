# WORLDBUG — Specifica tecnica verificabile

> Versione: 1.0 · Riferimento tecnico per l'implementazione browser single-player.
> La specifica descrive i contratti dei sistemi e come verificarli; non introduce backend,
> framework o servizi non richiesti. Per la visione usare `GDD.md`, per le regole di gioco
> implementate `DESIGN.md`, per le decisioni `DECISIONS.md` e per lo stato corrente `REGISTRY.md`.
> In caso di discrepanza sul comportamento già implementato prevale il codice indicato nelle
> sezioni qui sotto; una modifica di comportamento richiede l'aggiornamento di test e documenti.

## 1. Perimetro e vincoli architetturali

- Applicazione HTML5 statica, esecuzione locale nel browser: Canvas 2D per la mappa, DOM per HUD,
  pannelli e accessibilità, Web Audio opzionale per il suono.
- Giocatore singolo; nessun account, server, chiamata di rete, analytics o sincronizzazione.
- Persistenza limitata a progressione e impostazioni in `localStorage`. Lo stato della missione
  attiva non è serializzato: ricaricare la pagina non riprende la simulazione in corso.
- Logica a tick deterministici e casualità con seed; nessuna dipendenza dal tempo reale o da
  `Math.random` nella simulazione.
- Moduli separati per responsabilità, senza un framework di stato o un motore ECS: `core` simula,
  `game` orchestra, `ui` presenta e trasmette intenzioni, `render` disegna.

### Dipendenze ammesse

```text
main ──► ui ──► game ──► core
             ├──► render ──► core
             └──► content ──► core
```

`core` non importa UI, renderer o orchestrazione; `ui` non modifica direttamente `World`; renderer
non applica regole di gioco. I dati statici di `content` dipendono dai tipi e dalle funzioni pure di
`core`. Vietati cicli tra livelli. `main.ts` è il solo punto di bootstrap e gestione errori globali.

## 2. Modelli dati e fonti di verità

I nomi seguenti sono i contratti TypeScript correnti, non un secondo schema parallelo. Le proprietà
mutabili sono limitate alla simulazione o agli accumulatori; i dati esposti verso UI/renderer sono
sola lettura per contratto.

### 2.1 Contenuto immutabile

| Modello | Campi essenziali | Proprietario |
|---|---|---|
| `SpeciesDefinition` / `SpeciesTraits` | id, nome/codice, ruolo e dieta, tolleranze per temperatura/umidità/luce (`ideal`, `width`, `fragile`), risposta allo stress, energia, metabolismo, riproduzione, movimento e resa visiva | `content/species.ts`; tipi e fitness in `core/sim/species.ts` |
| `SectorConfig` | id/indice, dimensioni, seed, valori ambientali di base, sorgenti e impulsi, roster, popolazioni iniziali/cap, budget, obiettivo biomassa, durata in tick e strumenti disponibili | `content/sectors.ts`; schema e validazione in `core/sim/sector.ts` |
| `Proposition` | id, tipo (`role`, `tolerance`, `trophic`, `reproDriver`, `stress`), specie, opzioni, id corretto, motivazione, evidenze, peso e costo assist | derivato in `content/laws.ts` dai tratti e dall'osservazione canonica |
| `InstrumentSpec` | id, costi Carica/Integrità, requisito specie, distruttività, scorciatoia | `game/instruments.ts` |

I contenuti di campagna sono autoriali e statici. Ogni settore passa `validateSector`/`assertValidSector`
all'avvio/import; il catalogo delle proposizioni deve riferirsi a specie del roster e a opzioni valide.

### 2.2 Stato del mondo

| Modello | Dati | Regole di proprietà |
|---|---|---|
| `ScalarField` | griglia numerica per un `FieldId` (temperatura, umidità o luce) | range fisici: 150–450 K e 0–1 per gli altri campi; letture/modifiche solo tramite API campo |
| `Agent` | id, specie, posizione, direzione, energia, età, cooldown, stress, generazione, vivo/morto | creato/aggiornato/rimosso solo da `World`; id univoco nella vita del mondo |
| `World` | campi, biomassa per specie, agenti, roster, RNG, tick, eventi, contatori, probe, barriere e storia | singolo proprietario della simulazione; mutazioni attraverso metodi di `World` |
| `WorldEvent` | id monotono, tick, tipo, specie/bersaglio opzionali, posizione, causa, letture ambientali, quantità/messaggio | emesso solo quando avviene un fatto simulato; coda circolare limitata e contatori aggregati separati |
| `ProbeState` / `ProbeSample` | id, posizione, raggio, capacità e campioni con tick, campi, conteggi e biomassa | campionamento periodico; storico per probe limitato alla capacità |
| `WorldSnapshot` | conteggi, biomassa, statistiche campo, agenti, probe, storia, stabilità, barriere, campi ed estinzioni | fotografia di lettura per render/UI; nessuna regola di gioco viene eseguita dal consumatore |

`SpeciesId` è una stringa, ma il suo uso in roster, dieta, strumenti e leggi deve essere validato
rispetto al catalogo. Gli identificatori di settore, proposizione, strumento, evento, agente, probe e
barriera non sono intercambiabili.

### 2.3 Stato missione e applicazione

- `MissionPhase = briefing | survey | filed`.
- `Mission` possiede `World`, budget corrente e speso, risposte Codex, assist e risultato. È l'unico
  confine autorizzato per azioni del giocatore che cambiano il mondo o il budget.
- `Budget = { charge, integrity, spentCharge, spentIntegrity }`; ogni valore è non negativo e i
  valori spesi sono monotoni.
- `ReportAnswer = { propositionId, optionId, confidence: low | high }`.
- `Grade` contiene punteggio intero, rank (`S|A|B|C|F`), correttezza, conservazione, efficienza,
  biomassa, estinzioni, risorse spese e dettaglio per proposizione.
- `AppState` contiene schermata, impostazioni, progressione e selezioni HUD. Non duplica `World`.
  `createStore` notifica i consumatori; `Mission` resta posseduta da `createApp`.
- `SaveData` versione 1 contiene esclusivamente sblocchi, rank e impostazioni. Non contiene seed
  d'esecuzione, mondo, cronologia o risposte di una missione in corso.

## 3. Moduli e responsabilità

| Area/modulo | Unica responsabilità | Interfaccia/contratto osservabile |
|---|---|---|
| `core/rng.ts`, `math.ts` | casualità seeded e funzioni numeriche pure | `Rng` derivato da seed; nessuna sorgente casuale globale |
| `core/field.ts` | griglia scalare e operazioni spaziali/statistiche | campionamento, diffusione, rilassamento, pulse, clamp e statistiche |
| `core/sim/species.ts` | modello tratti e fitness/tolleranza | `fitnessAt`, `fitnessFactor`; fitness finita in `[0,1]` |
| `core/sim/sector.ts` | schema, clima, terreno e validazione settore | `validateSector` restituisce problemi; `assertValidSector` genera `ContentError` |
| `core/sim/world.ts` | ecosistema deterministico e stato fisico | `World.step/run`, letture, strumenti di simulazione, metriche, `snapshot()` |
| `core/sim/events.ts`, `metrics.ts` | eventi, aggregati, sonde e serie storiche | `EventLog`, `EventCounters`, campionamenti limitati e funzioni metriche |
| `content/*` | dati campagna, specie e leggi dedotte | `SECTORS`, `SPECIES_LIST`, `propositionsFor`; nessuna logica di UI |
| `game/instruments.ts` | catalogo e validazione/costo richieste strumenti | `validateRequest`, `checkAffordable`, `InstrumentRequest` |
| `game/session.ts` | lifecycle missione e confine di mutazione | `Mission.begin/advance/useInstrument/answer/buyAssist/file`; risultati discriminati `ok` |
| `game/grading.ts` | calcolo report senza mutare mondo/missione | `gradeReport`, funzioni scoring e `Rank` |
| `game/persistence.ts` | validazione e scrittura profilo locale versionato | `loadSave`, `writeSave`, `clearSave`; contratto iniettabile `StorageLike` |
| `game/store.ts`, `state.ts` | stato UI e notifiche osservabili | `get/set/patch/subscribe/select`; `AppState` |
| `game/audio.ts` | suono sintetico opzionale | `AudioBus`; guasti degradano a silenzioso, non bloccano la partita |
| `render/renderer.ts`, `palettes.ts` | disegno Canvas e trasformazioni viewport | `draw(World, RenderState)`, coordinate, resize e stato renderer |
| `ui/app.ts`, `ui/a11y.ts` | viste, input/accessibilità e loop principale | `Action`, `dispatch`, `frame`, `start/stop`, annunci DOM |
| `main.ts` | bootstrap e recupero da eccezioni non gestite | overlay diagnostico; inizializza app una volta |

Non introdurre worker, server, database, bus eventi generico o dipendenze framework senza una
necessità misurata: per la scala dei settori, chiamate sincrone e interfacce tipizzate bastano.

## 4. Interfacce di sistema e flussi

### 4.1 Simulazione

Interfaccia pubblica principale: `new World({ config, species, seed, ... })`, quindi `step()`/`run(n)`;
le azioni di mondo sono invocate solo dall'orchestrazione `Mission`. Per lo stesso contenuto, seed e
sequenza ordinata di tick/azioni, il risultato osservabile deve essere identico.

Ordine logico del tick: ambiente e impulsi → sensing/fitness → alimentazione e metabolismo →
movimento → riproduzione → morte/compattazione → contatori e campionamenti. Le implementazioni
interne possono cambiare solo preservando l'ordine causale degli eventi e i test deterministici.

### 4.2 Azioni missione

```ts
type ActionResult =
  | { ok: true; message: string; charge: number; integrity: number }
  | { ok: false; reason: string };

interface InstrumentRequest {
  instrument: InstrumentId; x: number; y: number; radius: number;
  species?: SpeciesId; x2?: number; y2?: number;
}
```

Prima di ogni strumento si controllano fase, id, coordinate/raggio, requisiti di specie/linea,
disponibilità nel settore e risorse. Solo dopo tutti i controlli si applicano gli effetti e si
addebitano i costi. Un'azione rifiutata non può avere effetti parziali, consumare budget o scrivere un
evento di applicazione. `Mission.advance(n)` esegue solo in fase `survey`, arrotonda a tick interi,
non accetta incrementi negativi e non supera `surveyTicks`.

`Mission.answer` accetta solo id/opzioni realmente presentati; le risposte possono essere sostituite
prima del deposito. Data Assist verifica fase, proposizione e budget e riporta le misure registrate
con la numerosità campionaria; non deve esporre `correctOptionId` né una risposta esplicita.

`Mission.file()` produce un solo report. Rifiuta una seconda consegna e rifiuta un mondo in cui tutte
le specie del settore sono estinte. Le proposizioni non risposte entrano nel grading come errate.
Il report chiude la missione e ogni ulteriore azione di gioco deve essere rifiutata, salvo navigazione.

### 4.3 UI, frame e input

Il DOM invia intenti serializzabili tramite la union discriminata `Action` e `dispatch`; non scrive
campi di `World` né modifica risorse direttamente. Il loop accumula tempo e lo converte in tick alla
velocità selezionata; pausa = zero tick, velocità zero ammessa, limite superiore governato dal set
`SPEEDS`. `frame(timeMs)` è esposto per test deterministici. Renderer e pannelli leggono stato e mondo,
ma le azioni passano sempre per `Mission`.

Gli aggiornamenti non urgenti dei pannelli possono essere raggruppati per evitare lavoro DOM a ogni
tick. Il Canvas non è l'unica fonte: riepiloghi, letture e risultati essenziali restano disponibili
nel DOM accessibile.

### 4.4 Eventi simulati

Eventi registrati sono fatti, non messaggi decorativi. I tipi correnti sono `birth`, `death`, `kill`,
`graze`, `extinction`, `introduction`, `cull`, `pulse`, `instrument`, `note`. Le morti indicano una
causa tra starvation, exposure, age, grazed, predation e culled. Le letture ambientali all'evento
sono uno snapshot, non un riferimento mutabile ai campi.

L'EventLog è una finestra circolare; `dropped` segnala record sovrascritti. I contatori aggregati
conservano i totali del run anche dopo la rotazione della finestra. Nessun dato di evento deve
riutilizzare un id o contenere NaN/Infinity.

### 4.5 Persistenza

`loadSave(StorageLike)` restituisce `{ data, warning }` e non propaga errori di storage o parsing.
Record corrotto/versione non supportata: non caricare dati parziali non validati, mettere il record
in quarantena best-effort e avviare un profilo pulito. `writeSave` segnala il fallimento senza
interrompere il gioco. I dati salvati sono solo progressione e opzioni; l'aggiornamento dello schema
richiede incremento `SAVE_VERSION` e percorso esplicito di coercizione/migrazione.

## 5. Invarianti verificabili

| ID | Invariante | Verifica automatica |
|---|---|---|
| INV-01 | Stesso settore, seed e sequenza di operazioni producono gli stessi conteggi, campi, eventi e risultato. | test di determinismo world/session; nessun `Math.random` in `src/core` |
| INV-02 | Campo e fitness sono finiti e nei limiti documentati; fitness è `[0,1]`. | `tests/core/field.test.ts`, `species.test.ts`, `world.test.ts` |
| INV-03 | Ogni organismo vivo ha id unico, specie nel roster e coordinate valide; la popolazione non supera il cap di specie. | test world e validazione settore |
| INV-04 | Budget corrente non negativo; spesa totale è monotona; un fallimento non modifica né budget né mondo. | test strumenti/sessione, caso limite per ciascun motivo di rifiuto |
| INV-05 | Tick missione monotono e compreso tra 0 e `surveyTicks`; non avanza fuori dalla fase survey. | test `Mission.advance` ai limiti, dopo filing e per input non valido |
| INV-06 | Ogni death ha causa; ogni evento ha tick/posizione validi e snapshot indipendente. | test EventLog/world, asserzioni sui campi evento |
| INV-07 | Buffer eventi e buffer probe sono limitati; la perdita del log è segnalata e gli aggregati restano esatti. | test overflow ring buffer/probe e contatori |
| INV-08 | Ogni legge ha opzioni uniche, una sola opzione corretta derivata da parametri/risultati del settore e supporto nell'audit di equità. | `tests/core/laws.test.ts`, `law-fairness.ts`, `npm run laws` |
| INV-09 | Assist mostra dati osservati (incluso `n`, oppure “no samples”), non la soluzione. | test assist su campioni nulli/presenti e scansione del testo rispetto alla risposta |
| INV-10 | Un report può essere archiviato una volta sola; il collasso totale impedisce il filing; risposte mancanti sono errate. | test lifecycle/grading |
| INV-11 | Lettura/manipolazione dei save non può bloccare il boot né accettare rank, setting o versione fuori schema. | test persistence: storage negato, JSON rotto, versioni, limiti settings |
| INV-12 | In assenza di Canvas 2D o Web Audio la UI non si blocca; le informazioni essenziali e le azioni non grafiche rimangono disponibili. | test UI/renderer/audio con capability assente |
| INV-13 | Nessuna richiesta di rete è necessaria durante il gioco e la build è distribuibile come bundle statico. | audit build: riferimenti runtime a fetch/XHR/WebSocket assenti e build statica riuscita |

## 6. Errori previsti e gestione

| Condizione | Rappresentazione | Comportamento richiesto |
|---|---|---|
| Richiesta strumento fuori mappa, coordinate/raggio non finiti o incompleti | `ActionResult { ok:false, reason }` | toast leggibile; nessuna spesa o mutazione |
| Specie non nel roster / strumento non equipaggiato / budget insufficiente | `ActionResult` con motivo specifico | UI mostra indisponibilità e conserva lo stato |
| Fase non valida, report già depositato, mondo completamente estinto | fallimento strutturato | nessuna eccezione per input del giocatore |
| Settore/specie/contenuto impossibile o incoerente | `ContentError` / `WorldBugError` | fallire presto in sviluppo/test; in esecuzione errore recuperabile e diagnostica |
| Violazione di un'invariante interna | `InvariantError` | non nascondere l'errore; overlay globale con contesto |
| Save corrotto, incompatibile o storage bloccato/quota esaurita | `PersistenceError` tradotto in warning / `SaveWriteResult` fallito | profilo pulito o gioco non persistito, senza bloccare la partita |
| Canvas nullo, zero dimensioni o contesto indisponibile | stato/warning renderer | continuare con interfaccia DOM e alternativa testuale |
| Audio API assente/rifiutata | stato audio non disponibile | silenzio; non impedire avvio, pausa o input |
| Eccezione non gestita o promise rejection | overlay `main.ts` | mostrare contesto/diagnostica e azione di ricarica; non lasciare pagina vuota |

Non usare eccezioni per normali scelte impossibili del giocatore. Le eccezioni tipizzate servono a
errori di contenuto o programmazione. Evitare `catch` vuoti, tranne operazioni best-effort di
quarantena/cleanup; ogni degradazione visibile produce un warning accessibile.

## 7. Criteri di accettazione

Una modifica è accettata quando soddisfa tutti i criteri applicabili, non solo quando “si avvia”.

### AC-01 — Isolamento dei sistemi
- Il core si testa in Node senza DOM; il renderer non cambia il mondo; la UI invia intenti tramite
  `dispatch`; `Mission` è il solo proprietario di lifecycle e budget.
- Verifica: typecheck, lint e suite unit/integration verdi; revisione delle dipendenze secondo §1.

### AC-02 — Ripetibilità
- Un replay della medesima missione con lo stesso seed e le stesse azioni restituisce snapshot e
  grading identici, senza dipendere da frequenza dei frame o orologio.
- Verifica: test deterministico su almeno un settore e azioni che includano almeno un intervento.

### AC-03 — Sicurezza economica delle azioni
- Ogni strumento disponibile applica effetto previsto e costo corretto; ogni rifiuto lascia invariati
  world e budget. La richiesta è respinta se la missione non dispone dello strumento, di Carica o
  Integrità, se il bersaglio è invalido o se la fase non è survey. La sola durata residua non è una
  risorsa dello strumento e non deve essere confrontata con il costo in Carica.
- Verifica: tabella test parametrizzata sulle 10 voci di `INSTRUMENTS`, positivi e negativi, inclusa
  una chiamata con pochi tick residui ma Carica sufficiente.

### AC-04 — Chiusura di missione e scoring
- La missione non supera la durata; filing su mondo vivo produce un unico `Grade`; filing dopo
  estinzione completa è negato; non risposte pesano come errate; rank e formula corrispondono a
  `game/grading.ts`.
- Verifica: test ai limiti del tick, soglie rank, punteggi estremi e filing ripetuto.

### AC-05 — Evidenza e correttezza del Codex
- Ogni assist deriva da dati realmente acquisiti e mostra numerosità; ogni proposizione è collegata
  ai parametri reali e supera l'audit automatico di distinguibilità/equità.
- Verifica: `npm run laws` con zero proposizioni ingiuste e test di assist senza campioni.

### AC-06 — Persistenza resiliente
- Progressione e impostazioni sopravvivono a reload; sessione in corso no. Save rotto o storage
  bloccato non impedisce il gioco e presenta un warning.
- Verifica: test con `memoryStorage`, record corrotto/versione errata e storage che lancia.

### AC-07 — Input e accessibilità di base
- In survey: mouse/touch/keyboard consentono selezione, navigazione, pausa, strumenti e filing;
  campi, stato popolazioni, risorse, Codex e feedback essenziali sono testo DOM leggibile anche se
  Canvas non disponibile. Le impostazioni accessibili restano applicate alla UI.
- Verifica: test DOM per dispatch/azioni, test renderer senza contesto e controllo manuale browser
  per tastiera e screen reader prima del rilascio.

### AC-08 — Build browser statica
- `npm run verify` termina con typecheck, lint, test e build; la build non richiede servizi esterni,
  non introduce asset binari non necessari e carica da percorso relativo.
- Verifica: `npm run verify`; ispezione bundle e smoke test su browser moderno.

### Comandi di gating

```sh
npm run typecheck
npm run lint
npm test
npm run laws
npm run verify
```

Test prestazionali su hardware reale e prove di usabilità/accessibilità sono criteri di rilascio
manuali, non devono essere sostituiti da benchmark sintetici. Per il target attuale verificare la
campagna completa, includendo TAU-7, con un browser reale.

## 8. Confini e note di coerenza

1. Il GDD descrive la possibilità di salvare a ogni azione rilevante, ma l'implementazione salva il
   profilo (progressione/impostazioni), non il run attivo. Questa specifica rende esplicito che il
   resume del run non è requisito corrente.
2. Il report può essere depositato prima della fine della finestra, purché il mondo non sia del tutto
   estinto; allo scadere, la missione invita al filing. Le proposizioni ancora senza risposta sono
   valutate errate. È il comportamento del codice corrente.
3. **Difetto noto da correggere:** `Mission.availability/useInstrument` passa `remainingTicks` come
   argomento `remainingCharge` a `checkAffordable`; così un costo Carica può essere confrontato con
   tick residui e disabilitare erroneamente strumenti vicino alla scadenza. Il contratto previsto è
   il solo controllo del budget Carica/Integrità e della disponibilità nel settore. AC-03 include il
   test di regressione; fino alla correzione il comportamento runtime non è conforme a tale criterio.
4. Il test di equità dimostra proprietà del contenuto e della strategia automatizzata, non garantisce
   da solo la comprensibilità per una persona. Il playtest umano per ogni settore resta necessario.
5. Qualunque futura richiesta di salvataggio/ripresa della missione, campagna procedurale, worker o
   servizio online costituisce un ampliamento del perimetro: richiede decisione architetturale,
   schema/versionamento e nuovi criteri di accettazione, non va aggiunto implicitamente.
