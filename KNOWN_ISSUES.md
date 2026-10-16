# WORLDBUG — Problemi noti e rischi

> Aggiornato: 2026-10-16. Le voci aperte non sono considerate completate. Rimuovere una voce soltanto
> dopo correzione e verifica riproducibile; registrare la risoluzione in `docs/DECISIONS.md` se utile.

## Difetti confermati

| ID | Priorità | Problema | Impatto e riproduzione | Criterio di chiusura |
|---|---|---|---|---|
| BUG-01 | P2 | Costo Carica confrontato con tick residui | `Mission.availability()` e `Mission.useInstrument()` passano `remainingTicks` al parametro `remainingCharge` di `checkAffordable()`. Verso la fine della finestra un'azione può essere rifiutata perché il costo in Carica supera i tick residui, anche se il budget è sufficiente. | Rimuovere il confronto tra unità diverse; testare che un'azione economicamente accessibile funzioni con meno tick residui del suo costo in Carica, se il gioco è ancora in fase `survey`. Test negativi per Carica/Integrità restano verdi. |

## Rischi e validazioni aperte

| ID | Priorità | Rischio | Stato attuale | Prossimo passo |
|---|---|---|---|---|
| RISK-01 | P1 | Copertura ecologica su pochi seed | Dopo il refactor delle fasi, `tests/core/viability.test.ts` e `npm run balance -- 0 '' --seeds=3` hanno mantenuto tutte le specie vive nei 15 run testati; non è una dimostrazione su tutte le configurazioni casuali. | Eseguire `npm run balance -- 0 '' --seeds=20` e registrare output/seed falliti prima del release candidate. |
| RISK-02 | P1 | Esperienza dei settori avanzati non confermata da playtest | I test automatici esercitano i sistemi, ma il playthrough umano documentato è soprattutto FER-1. | Giocare KEL-4, ORP-2 e TAU-7 dall'inizio al report; verificare leggibilità degli indizi, budget e tempi. |
| RISK-03 | P1 | Browser/rendering e accessibilità reale | Renderer e DOM sono testati con un contesto Canvas registrante/jsdom; questo non equivale a browser grafico, screen reader o hardware touch. | Smoke test su almeno un browser desktop e uno mobile, tastiera e screen reader; registrare browser/versione e risultati. |
| RISK-04 | P2 | Frame pacing su hardware di riferimento | L'harness headless misura throughput; non misura il costo integrato di rendering e aggiornamento dei pannelli su laptop datato. | Profilare TAU-7 con 600 organismi su dispositivo target; controllare frame budget e degradazione qualità. |
| RISK-05 | P2 | Lingua dei testi non definita per release | Le stringhe di gioco sono prevalentemente in inglese; l'italiano della documentazione non implica localizzazione del gioco. | Decidere lingua release; se serve localizzazione, estrarre le stringhe in dati e testare i fallback. |
| RISK-06 | P3 | La missione corrente non è ripristinata dopo reload | Il salvataggio v1 contiene progressione e impostazioni, non mondo, seed/actions o risposte in corso. È una decisione di scope documentata, non corruzione del save. | Mantenere come limite esplicito oppure approvare un ADR per snapshot, versionamento e test di replay/resume. |
| RISK-07 | P3 | Validatore import mantenuto manualmente | `src/domain/validation.ts` controlla la struttura esterna e delega la validazione semantica a `validateSector`/`coerceSave`; modifiche agli schemi richiedono aggiornare anche test e parser. | Ogni modifica a `SectorConfig` o `SaveData` aggiorna parser, test malformed e versione save, senza aggiungere un generatore schema senza necessità. |

## Rischi non presenti nel perimetro corrente

- Nessuna integrazione analytics, pubblicitaria, cloud o account: non è un bug. Non aggiungerla senza
  decisione esplicita su privacy, consenso, rete e isolamento architetturale.
- Nessun framework UI, database, servizio remoto o worker: non è un gap rispetto allo scope v1.

## Controllo periodico

Al termine di una milestone eseguire almeno `npm run verify` e `npm run laws`; modificare lo stato di
ogni voce qui e in `PROJECT_STATUS.md` soltanto con evidenza. Per i cambi di comportamento registrare
la decisione/risoluzione in `docs/DECISIONS.md` e aggiornare i criteri in `docs/TECHNICAL_SPEC.md`.
