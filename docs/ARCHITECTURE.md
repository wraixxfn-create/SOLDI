# WORLDBUG — Stack e struttura

> Specifica di stack e confini dei moduli. Complementa `TECHNICAL_SPEC.md` (contratti e acceptance),
> `DESIGN.md` (regole di gioco) e `REGISTRY.md` (stato di implementazione). Le decisioni architetturali
> accettate sono registrate in `DECISIONS.md`.

## 1. Valutazione e scelta dello stack

Lo stack corrente è adatto a un gioco browser single-player con una mappa 2D, simulazione deterministica
locale e interfaccia relativamente piccola. **Si mantiene lo stack: non c'è un vantaggio misurabile che
giustifichi una migrazione.**

| Tecnologia | Uso | Motivo della scelta |
|---|---|---|
| TypeScript 5, strict | Simulazione, logica e UI | Tipi per specie/eventi/azioni; `strict`, `noUncheckedIndexedAccess` e `no-non-null-assertion` aiutano a trovare errori ai confini dei dati. Compila in JavaScript standard. |
| Vite 8 | Dev server e build statica | Avvio rapido, output statico con percorsi relativi (`base: './'`), nessun runtime Vite nel gioco. Il server locale lega `0.0.0.0` per preview/port forwarding. |
| Canvas 2D nativo | Mappa e organismi | Adeguato a griglia e primitive 2D; nessun renderer o asset pipeline da scaricare. La UI resta separata dal Canvas. |
| HTML e CSS nativi | Schermate, pannelli, controlli e accessibilità | Testo selezionabile e semantica DOM, tastiera e screen reader senza ricreare controlli dentro il Canvas. |
| Web Audio API | Audio sintetico facoltativo | Nessun file audio o richiesta di rete; il gioco continua se l'API è assente o bloccata. |
| Vitest | Test unitari e d'integrazione | Runner TypeScript coerente con Vite, adatto anche ai test headless del core. |
| jsdom | Test UI DOM | Verifica dispatch e rendering dei pannelli senza introdurre un browser completo nei test quotidiani. |
| ESLint + typescript-eslint | Analisi statica | Controlla errori e convenzioni TS; non è necessario aggiungere un secondo linter. |
| Node.js 22.22.2+ | Tooling locale/test | Versione dichiarata in `package.json`; esegue harness TypeScript e script di bilanciamento. Non è richiesto al giocatore. |

Il bundle di produzione non ha dipendenze JavaScript runtime. Vite, TypeScript, Vitest, jsdom ed ESLint
sono strumenti di sviluppo/test, non servizi o librerie caricati dal browser. Sviluppo, test e build
sono gratuiti e locali; nessun account o servizio cloud è necessario.

### Framework UI: valutazione

React, Vue, Svelte e simili non sono giustificati dalla UI attuale. `src/ui/app.ts` gestisce una shell
DOM contenuta, un dispatcher esplicito e pannelli aggiornati in modo selettivo; aggiungere un framework
comporterebbe runtime o pipeline e manutenzione senza risolvere un problema dimostrato. Rivalutare solo
se la UI cresce significativamente (molte viste indipendenti, gestione complessa di form/stato o lavoro
parallelo di più sviluppatori) e un prototipo mostra un vantaggio concreto su dimensione, accessibilità
o manutenibilità. Non migrare per preferenza stilistica.

### Test e lint

- `npm run typecheck`: TypeScript in modalità strict su codice, test e configurazioni.
- `npm run lint`: ESLint/TypeScript-ESLint; tipi espliciti, niente `any` o non-null assertion.
- `npm test`: Vitest; test unitari per core e test d'integrazione UI su jsdom. Renderer provato con
  contesto Canvas registrante, non con screenshot di un browser.
- `npm run laws`, `npm run balance`: audit delle leggi e harness ecologico deterministici.
- `npm run verify`: typecheck + lint + test + build di produzione.

I test correnti coprono simulazione, contenuto, renderer e UI. Un browser E2E (per esempio Playwright)
non è una dipendenza necessaria per lo sviluppo ordinario: aggiungerlo solo se una regressione critica
non è verificabile con test esistenti o per una suite di rilascio browser ripetibile. Prima del rilascio
restano necessarie prove manuali su browser reali, in particolare per Canvas, tastiera, audio e tecnologie
assistive: jsdom non simula tali piattaforme.

### Compatibilità e build

La build punta a `es2022` (`vite.config.ts`) e richiede Canvas 2D per la mappa. Web Audio è opzionale;
se Canvas 2D non è disponibile, pannelli e letture testuali devono rimanere utilizzabili. Il bundle usa
`base: './'`, è statico e non richiede routing server-side. La compatibilità dichiarata è con browser
moderni che implementano ES2022, moduli JavaScript, Canvas 2D e le API DOM usate; una matrice precisa di
versioni browser va fissata solo quando il rilascio definisce i browser supportati e verificata con test
reali.

## 2. Struttura attuale e proprietà dei sistemi

```text
src/
├── main.ts                  # bootstrap, error boundary globale
├── core/                    # simulazione e meccaniche pure, senza DOM
│   ├── errors.ts
│   ├── field.ts             # campi scalari e operazioni sulla griglia
│   ├── math.ts
│   ├── rng.ts               # PRNG seeded
│   └── sim/
│       ├── species.ts       # tratti, strategie, fitness e comportamento
│       ├── sector.ts        # schema/validazione mondo, clima e terreno
│       ├── resources.ts     # stock di acqua/nutrienti e dinamiche per turno
│       ├── rules.ts         # AST ecologica sicura e scheduling
│       ├── world.ts         # fasi discrete, agenti e mutazioni del mondo
│       ├── events.ts        # eventi, ring buffer e aggregati
│       └── metrics.ts       # probe, storia e metriche derivate
├── content/                 # dati authored: non è codice di schermata
│   ├── species.ts           # catalogo specie e parametri
│   ├── sectors.ts           # cinque configurazioni iniziali di mondo/campagna
│   ├── starter-ecosystem.ts # mondo template con quattro strategie ecologiche
│   ├── laws.ts              # proposizioni generate dai parametri/osservazioni
│   └── law-fairness.ts      # audit di equità del Codex
├── domain/                  # contratti cross-module e validazione dati importati
│   ├── contracts.ts
│   └── validation.ts
├── game/                    # regole della missione e stato applicativo
│   ├── session.ts           # lifecycle, tick, azioni, budget e report
│   ├── instruments.ts       # definizioni e validazione degli strumenti
│   ├── grading.ts           # score/rank e feedback
│   ├── state.ts             # tipi e stato dell'app
│   ├── store.ts             # store osservabile minimale
│   ├── persistence.ts       # profilo versionato in localStorage
│   └── audio.ts             # Web Audio, opzionale
├── render/                  # Canvas 2D e palette, senza regole di simulazione
│   ├── renderer.ts
│   └── palettes.ts
└── ui/                      # DOM, input, layout e accessibilità
    ├── app.ts               # dispatcher e frame loop
    ├── a11y.ts
    └── styles.css

tests/                       # specchiati per core, render e ui
 tools/                       # harness locali (balance, laws, trace)
```

### Responsabilità e confini logici

- **Simulazione:** `core/sim/world.ts`, con `resources.ts`, `rules.ts`, `field.ts`, `rng.ts`, `species.ts`
  ed `events.ts`. Ogni istanza valida la configurazione; `World.step()` esegue sette fasi discrete
  documentate e non conosce DOM, UI, Canvas, audio o SDK.
- **Regole di gioco:** le regole ecologiche declarative sono validate e interpretate da
  `core/sim/rules.ts` (AST chiusa, nessun codice eseguibile); le regole missione (azioni, costi,
  lifecycle, report) sono in `game/`. Le proposizioni Codex restano in `content/laws.ts`.
- **Generazione/configurazione mondi:** la campagna resta authored, senza generazione procedurale.
  `SectorConfig` contiene territorio, clima, stock iniziali di acqua/nutrienti, sorgenti, roster e regole;
  `validateWorldConfig` è il gate di ogni `World`. `content/starter-ecosystem.ts` mostra quattro
  strategie iniziali validate. La casualità è seeded; la UI non duplica la configurazione.
- **Gameplay/orchestrazione:** `game/session.ts` possiede la missione e instrada le azioni verso core;
  `game/instruments.ts` è il catalogo e il validatore dei comandi, non una seconda simulazione.
- **Rendering:** `render/renderer.ts` legge mondo e stato visuale; palette e coordinate sono
  responsabilità render. Il renderer non decide effetti, costi o risultati.
- **Interfaccia:** `ui/` riceve input, presenta dati e invia intenti tipizzati tramite `dispatch`.
  `main.ts` effettua il bootstrap e intercetta errori fuori dal flusso normale.
- **Persistenza:** attualmente `game/persistence.ts`, tenuta distinta per responsabilità dal loop e
  dalla simulazione: serializza solo progressione/impostazioni e gestisce schema/errori storage.
- **Audio:** attualmente `game/audio.ts`, adattatore isolato per Web Audio; non ha accesso a regole
  ecologiche e non è mai prerequisito per gameplay.
- **Analytics e integrazioni esterne:** non implementate e fuori perimetro v1. Non creare cartelle
  vuote o dipendenze fittizie. In caso di decisione futura, aggiungere moduli isolati (`analytics/`,
  `integrations/`) dietro interfacce opzionali, senza import nel core e senza bloccare il gioco quando
  il servizio manca; qualsiasi telemetria richiederà prima una decisione esplicita su consenso,
  privacy, rete e impatto sul gioco.

I moduli di persistenza e audio si trovano ancora sotto `game/` per mantenere l'albero piccolo: sono
file autonomi e dipendenze iniettate/consumate dalla shell; non serve spostarli finché il numero di
file e la collaborazione non rendono la collocazione un problema. Se la cartella `game/` si allarga,
si possono estrarre in `persistence/` e `audio/` con un vantaggio di navigazione dimostrabile, senza
cambiare contratti o stack.

## 3. Grafo delle dipendenze

```text
                    ┌──────────────┐
                    │   main.ts    │
                    └──────┬───────┘
                           ▼
                   ┌─────────────────────┐
                   │         ui          │
                   └───┬────┬────┬───────┘
                       │    │    │
             ┌─────────┘    │    └──────────┐
             ▼              ▼               ▼
       ┌──────────┐   ┌──────────┐   ┌──────────────┐
       │   game   │   │  render  │   │ persistence  │
       └────┬─────┘   └────┬─────┘   └──────────────┘
            │              │        ┌──────────────┐
            ├───────┐      │        │    audio     │
            ▼       ▼      ▼        └──────────────┘
       ┌────────┐ ┌─────────┐
       │ content│ │  core   │
       └───┬────┘ └────▲────┘
           └───────────┘
```

Le frecce rappresentano dipendenze di codice, non necessariamente import diretti da ogni sottosistema.
UI crea/usa le API game e renderer; `Mission` usa i dati content e le API core. Persistence/audio
sono adattatori a cui l'applicazione delega le operazioni laterali. `domain/` è un facade di contratti
ad alto livello usato dalle validazioni/test: può riferirsi a core, content e game, ma non è importato
dal core e non è un nuovo livello da cui la simulazione dipende.

### Regole non negoziabili

1. `core/` importa solo `core/` e tipi puri; niente `window`, `document`, Canvas, `localStorage`, rete,
   audio, UI, game o SDK.
2. `content/` può importare `core/` e dati content; non importa `game/`, UI, renderer o browser API.
3. `game/` può importare core/content e i contratti degli adattatori storage/audio; non manipola DOM.
4. `render/` può leggere core e tipi visuali; non importa `game/` per cambiare stato. Input/output
   visuali sono valori espliciti.
5. `ui/` può orchestrare game, render, persistenza e audio; non muta `World` o `Budget` direttamente.
6. Integrazioni future (analytics, ads, servizi cloud) possono essere chiamate solo da un adapter
   esplicito usato dalla shell/app, mai da core/content/render. Sono disabilitate per default e non
   possono diventare una dipendenza necessaria al caricamento o al loop.
7. Evitare cicli, service locator globali e bus eventi generici. Preferire tipi condivisi piccoli,
   chiamate dirette e risultati `Result` tipizzati alle dimensioni attuali.

## 4. Flusso di un frame e di un'azione

```text
requestAnimationFrame → ui/app.frame(time)
  ├─ accumula tempo reale e determina tick interi (velocità/pausa)
  ├─ Mission.advance(tickCount) → World.run(n) → World.step()
  ├─ legge stato e metriche per aggiornare pannelli DOM quando necessario
  └─ Renderer.draw(world, renderState)

input DOM/Canvas → Action → dispatch → Mission/Store
  └─ esito ok/failure → feedback UI; persistenza profilo quando pertinente
```

Il tempo reale regola la presentazione, non le formule della simulazione: con lo stesso seed e lo stesso
elenco ordinato di azioni e tick, l'esito non cambia al variare del frame rate. La pausa esegue zero
tick. Il renderer non è il proprietario del loop di regole.

## 5. Errori e degradazione

| Sistema | Comportamento in errore |
|---|---|
| Core/contenuti | `WorldBugError`, `ContentError` o `InvariantError` per input/configurazioni impossibili; validazione ai confini e test. |
| Azioni gameplay | Esito `{ ok: false, reason }` per limiti normali del giocatore; nessuna eccezione o spesa parziale. |
| Persistenza | Warning su save invalido/storage bloccato; avvio con profilo pulito o gioco senza salvataggio. |
| Canvas | Avviso e UI DOM/testo funzionante quando il contesto non è disponibile. |
| Audio | Stato non disponibile/silenzioso senza bloccare le azioni. |
| Errore non gestito | Overlay recuperabile e diagnostica in `main.ts`, non pagina vuota. |
| Integrazioni future | Adapter non disponibile = funzionalità opzionale disattivata; core e loop non attendono la rete. |

## 6. Comandi e criteri di mantenimento

```sh
npm run dev       # Vite in locale
npm run typecheck
npm run lint
npm test
npm run laws      # audit delle proposizioni
npm run balance   # bilanciamento headless
npm run verify    # suite completa + build statica
```

Non aggiungere una dipendenza se una API browser nativa o un modulo locale piccolo copre già il caso.
Ogni nuova libreria deve avere una responsabilità non già coperta, costo bundle/build noto, licenza
compatibile, manutenzione attiva e strategia di test. Ogni nuova cartella deve rappresentare un dominio
con proprietario e API definite, non essere creata solo per anticipare una possibile crescita.
