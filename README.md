# WORLDBUG

WORLDBUG è un gioco browser single-player di simulazione di ecosistemi alieni e deduzione scientifica.
Il progetto gira interamente nel browser: nessun account, backend, analytics o chiamata di rete durante
la partita.

## Prerequisiti

- Node.js **22.22.2 o superiore** e npm (per installare, testare e compilare; vedere `package.json`).
- Browser moderno con moduli JavaScript, DOM ed ES2022; Canvas 2D per la mappa. Web Audio è facoltativo.
- Git per clonare il repository.

## Clonare, installare e avviare

```bash
git clone https://github.com/wraixxfn-create/SOLDI.git
cd SOLDI
npm ci
npm run dev
```

Vite avvia il server locale su `http://localhost:5173` (bind `0.0.0.0`, utile anche per preview inoltrate).
Apri l'indirizzo stampato dal comando. Premi **Begin survey** per iniziare. Il browser non richiede
installazione di dipendenze di gioco: `npm ci` installa solo gli strumenti di sviluppo.

Per provare la build di produzione localmente:

```bash
npm run build
npm run preview
```

La build è in `dist/` ed è statica: si può servire da hosting statico o da una sottocartella, senza
backend. Non aprire direttamente `index.html` da `file://`: usa il server Vite o un server HTTP statico.

## Comandi di sviluppo

| Comando | Descrizione |
|---|---|
| `npm run dev` | Server di sviluppo Vite su porta 5173 |
| `npm run build` | Typecheck e build di produzione in `dist/` |
| `npm run preview` | Serve la build locale, normalmente su porta 4173 |
| `npm run typecheck` | TypeScript strict senza generare file |
| `npm run lint` | ESLint su codice e test |
| `npm run lint:fix` | Correzioni automatiche ESLint dove sicure |
| `npm test` | Suite Vitest in modalità singola |
| `npm run test:watch` | Vitest in modalità watch |
| `npm run coverage` | Test con report coverage V8 |
| `npm run check` | Typecheck, lint e test |
| `npm run verify` | Tutti i controlli e build di produzione |
| `npm run balance -- [ticks] [SETTORE] [--seeds=N]` | Harness di bilanciamento headless |
| `npm run trace -- <SETTORE> <SPECIE> [ticks] [intervallo] [seed]` | Diagnostica di una popolazione |
| `npm run laws -- [--margins]` | Audit delle leggi/proposizioni e della loro equità |

Prima di aprire una PR o dichiarare una milestone verificata, esegui:

```bash
npm ci
npm run verify
npm run laws
```

## Struttura del progetto

```text
src/
├── main.ts           # bootstrap e overlay errori globali
├── core/             # RNG, matematica, campi e simulazione deterministica
├── content/          # specie, settori e leggi authored/verificate
├── domain/           # contratti pubblici e validazione runtime degli import
├── game/             # missione, strumenti, scoring, store, save e audio
├── render/           # Canvas 2D, palette e viewport
└── ui/               # DOM, input, frame loop e accessibilità

tests/                # test per dominio, core, renderer e UI
 tools/                # harness locali per leggi, trace e bilanciamento
docs/                 # GDD, specifica tecnica, architettura e decisioni
```

I limiti delle dipendenze sono descritti in `docs/ARCHITECTURE.md`: il core non importa DOM, UI,
renderer, persistenza o audio; le azioni passano dall'orchestrazione missione; render e UI non scrivono
lo stato della simulazione. `src/domain/contracts.ts` descrive i contratti di World, Species,
Organism, Environment, Rule, Experiment, Objective, SimulationState, Challenge e PlayerProgress.
`src/domain/validation.ts` verifica challenge e progressi importati da `unknown` prima di accettarli.

## Comandi di gioco

`Space` pausa/riprende · `1`–`0` seleziona strumenti · frecce muovono il cursore · `Enter` applica lo
strumento · `O` cambia overlay · `P` piazza una sonda · `R` recupera una sonda · `F` deposita il report
· `?` apre l'aiuto. Mouse, penna e touch sono supportati sulla mappa.

## Debug e diagnosi

1. **Il server non parte:** controlla `node --version` (>= 22.22.2), riesegui `npm ci` e verifica che
   le porte 5173/4173 non siano già occupate; entrambe sono configurate `strictPort`.
2. **La pagina è vuota o segnala un errore:** leggi l'overlay diagnostico della pagina e la console
   del browser. `main.ts` mostra errori non gestiti e consente di copiare il report. Prova prima il
   reload; in sviluppo usa la console per individuare il modulo sorgente.
3. **Simulazione o legge errata:** esegui `npm test`, `npm run laws` e poi `npm run trace -- FER-1 AUR-3`
   (sostituisci settore/specie secondo il problema). I mondi sono deterministici: riutilizza lo stesso
   settore, seed e sequenza di azioni nel bug report.
4. **Test/typecheck/lint falliti:** `npm run typecheck` localizza errori di tipo; `npm run lint` mostra
   file e riga; `npx vitest run tests/domain/contracts.test.ts` esegue i test dei contratti isolatamente.
5. **Salvataggio:** il profilo è nel `localStorage` del browser. Usa Settings → Reset profile per
   cancellare progressione e impostazioni; la partita attiva non viene salvata e non si riprende dopo
   un reload.
6. **Canvas non disponibile:** la UI deve restare leggibile via DOM; controlla l'avviso renderer. I
   test jsdom simulano intenzionalmente l'assenza del contesto Canvas.

Per l'architettura scelta e la compatibilità vedi `docs/ARCHITECTURE.md`; per contratti e criteri
verificabili `docs/TECHNICAL_SPEC.md`; per stato, rischi e lavori aperti vedi `PROJECT_STATUS.md` e
`KNOWN_ISSUES.md`.
