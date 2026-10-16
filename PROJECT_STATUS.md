# WORLDBUG — Stato del progetto

> Aggiornato: 2026-10-16. Il codice e i test sono la fonte del comportamento; `docs/REGISTRY.md` conserva
> l'inventario storico. Questo riepilogo distingue implementato, verificato e ancora da validare.

## Stato sintetico

**Applicazione browser avviabile e giocabile end-to-end; milestone contratti/configurazione completata.**
Il repository era già oltre la milestone iniziale di Canvas + loop + reset prima di questo intervento:
non è stato sostituito con una demo incompleta. La schermata di survey usa il Canvas 2D e un loop
controllato; il report permette di riavviare il settore e Settings consente di resettare il profilo.

La milestone corrente aggiunge contratti tipizzati di dominio, validatori runtime per challenge e
progressi importati, test di regressione, istruzioni di clonazione/avvio/debug e aggiornamento delle
decisioni/rischi. Nessun nuovo servizio o dipendenza runtime è stato introdotto.

## Funzionalità completate e verificate

| Area | Stato verificato | Evidenza |
|---|---|---|
| Stack e installazione | Completato | Node 22.22.3; `npm ci` completato da lockfile; nessuna vulnerabilità segnalata |
| Avvio locale | Completato | `npm run dev -- --host 0.0.0.0` avviato; porta 5173 pronta; richiesta HTTP alla shell ha restituito titolo, Canvas e entrypoint |
| Build | Completato | `npm run verify`; Vite 8.3.4 ha prodotto build statica |
| Typecheck e lint | Completato | `tsc --noEmit` e ESLint, zero errori e zero warning |
| Suite automatica | Completato | **166 test passati in 11 file** con Vitest |
| Audit Codex | Completato | `npm run laws`: tutte le proposizioni delle cinque missioni risultano non ambigue e verificabili |
| Contratti dominio | Completato | `src/domain/contracts.ts`: World, Species, Organism, Environment, Rule, Experiment, Objective, SimulationState, Challenge, PlayerProgress |
| Validazione import | Completato | `src/domain/validation.ts`: challenge da `unknown` validata prima della simulazione; regole Codex rigenerate; progressi passati dallo schema save |
| Regole di dipendenza | Documentate | `docs/ARCHITECTURE.md` e `docs/TECHNICAL_SPEC.md`; il core non dipende da UI/DOM/SDK |
| Stato decisioni/rischi | Documentato | `docs/DECISIONS.md` (ADR-012), questo file e `KNOWN_ISSUES.md` |

Comandi eseguiti con esito positivo in questa milestone:

```text
npm ci
npm run verify       # 166/166 test, lint/typecheck puliti, build riuscita
npm run laws         # equità passata per tutti i settori
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
- I contratti sono verificati con test strutturali e validazione import; non sostituiscono i modelli
  interni già in uso e vanno aggiornati insieme a `SectorConfig`/`SaveData`.

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
