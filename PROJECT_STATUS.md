# WORLDBUG — Stato del progetto

> Aggiornato: 2026-10-16. Il codice e i test sono la fonte del comportamento; `docs/REGISTRY.md` conserva
> l'inventario storico. Questo riepilogo distingue implementato, verificato e ancora da validare.

## Stato sintetico

**Applicazione browser avviabile e giocabile end-to-end; modello ecologico, ciclo discreto, determinismo e DSL regole completati.**
Il repository era già oltre la milestone iniziale di Canvas + loop + reset prima di questo intervento:
non è stato sostituito con una demo incompleta. La schermata di survey usa il Canvas 2D e un loop
controllato; il report permette di riavviare il settore e Settings consente di resettare il profilo.

La milestone corrente rende espliciti stock di acqua/nutrienti e limiti, aggiunge le quattro strategie
starter, valida ogni World in costruzione e separa il turno in sette fasi. Le regole authored sono AST
tipizzate senza codice eseguibile; gli stream RNG sono derivati per agente/turno e il rendering è testato
come lettore. Sono mantenuti la campagna e i contratti/import validator preesistenti.

## Funzionalità completate e verificate

| Area | Stato verificato | Evidenza |
|---|---|---|
| Stack e installazione | Completato | Node 22.22.3; `npm ci` completato da lockfile; nessuna vulnerabilità segnalata |
| Avvio locale | Completato | `npm run dev -- --host 0.0.0.0` avviato; porta 5173 pronta; richiesta HTTP alla shell ha restituito titolo, Canvas e entrypoint |
| Build | Completato | `npm run verify`; Vite 8.3.4 ha prodotto build statica |
| Typecheck e lint | Completato | `tsc --noEmit` e ESLint, zero errori e zero warning |
| Suite automatica | Completato | **186 test passati in 14 file** con Vitest |
| Audit Codex | Completato | `npm run laws`: tutte le proposizioni delle cinque missioni risultano non ambigue e verificabili |
| Modello del mondo | Completato | `WorldConfig`/`SectorConfig`: territorio chiuso 16–128×12–128, clima, acqua 0–1, nutrienti 0–4/cella; `validateWorldConfig` e snapshot immutabile |
| Modello delle specie | Completato | quattro strategie starter (`PHY-1`, `PRE-1`, `DEC-1`, `SYM-1`) e 12 specie campagna; bisogni, dieta, life history, mobilità e interazioni condividono il motore |
| Ciclo e determinismo | Completato | sette fasi documentate, coorte ordinata per ID, nascite differite, RNG derivato per agente/turno; replay con azioni e rendering/headless identici nei test |
| Motore regole | Completato | `src/core/sim/rules.ts`: prerequisiti AST, priorità, modalità stack/exclusive, once/each-turn, effetti enumerati; parser bounded rifiuta codice/operazioni sconosciute |
| Contratti dominio | Completato | `src/domain/contracts.ts`: World, Species, Organism, Environment, Rule, Experiment, Objective, SimulationState, Challenge, PlayerProgress |
| Validazione import | Completato | `src/domain/validation.ts`: challenge da `unknown` validata prima della simulazione; regole Codex rigenerate; progressi passati dallo schema save |
| Regole di dipendenza | Documentate | `docs/ARCHITECTURE.md` e `docs/TECHNICAL_SPEC.md`; il core non dipende da UI/DOM/SDK |
| Stato decisioni/rischi | Documentato | `docs/DECISIONS.md` (ADR-012/013), questo file e `KNOWN_ISSUES.md` |

Comandi eseguiti con esito positivo in questa milestone:

```text
npm ci
npm run verify       # 186/186 test in 14 file, lint/typecheck puliti, build riuscita
npm run laws         # zero proposizioni dichiarate unfair nei cinque settori
npm run dev -- --host 0.0.0.0  # Vite pronto su 5173
curl http://127.0.0.1:5173/   # shell HTML servita con successo
```

## Implementato ma non validato completamente

- Campagna di cinque settori, 12 specie, strumenti, Codex, scoring, progressione, persistenza del profilo,
  audio sintetico e supporto accessibile DOM/Canvas.
- Simulazione e rendering hanno test automatizzati headless; non è stata acquisita una prova screenshot
  su un browser grafico reale in questa esecuzione.
- I test di bilanciamento registrati nel registro coprono tre seed per settore; una ricerca più ampia
  resta consigliata.
- Il mondo starter con quattro strategie è un template/headless core testato; la schermata della campagna
  continua a usare i cinque settori authored. Nuove modifiche a `SectorConfig`, risorse o regole devono
  aggiornare insieme parser, validazione runtime e test malformed.

## Prossimi passi

1. Correggere e testare il confronto improprio tra tick residui e costo Carica, descritto in
   `KNOWN_ISSUES.md`.
2. Completare playtest manuali di KEL-4, ORP-2 e TAU-7; verificare in browser reale mouse/touch,
   tastiera, resa Canvas e comportamento audio.
3. Eseguire balance con almeno 20 seed per settore e profilare TAU-7 su hardware di riferimento.
4. Decidere la lingua dei testi destinati alla release e documentare una matrice esplicita dei browser
   supportati.
5. Aggiornare questo stato, `KNOWN_ISSUES.md`, il registro e le decisioni a ogni milestone; non
   trasformare rischi non testati in “completati”.

## Riferimenti

- `README.md` — prerequisiti, comandi, avvio e debug.
- `docs/TECHNICAL_SPEC.md` — contratti, invarianti e acceptance criteria.
- `docs/ARCHITECTURE.md` — stack, responsabilità e dipendenze.
- `docs/REGISTRY.md` — inventario tecnico storico e prove di progetto.
- `KNOWN_ISSUES.md` — difetti e verifiche ancora aperte.
