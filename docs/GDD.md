# WORLDBUG — Game Design Document (GDD)

> Stato: **bozza v2.0** per revisione del proprietario. Complementa `docs/DESIGN.md` (regole implementate,
> autorevole per il comportamento attuale) e `docs/REGISTRY.md` (stato di implementazione).
> Ove questo GDD propone cambiamenti rispetto al codice, lo segnala esplicitamente con **[PROPOSTA]**.
> Ove un'ipotesi non è verificata, è marcata **[IPOTESI]** e raccolta nella sezione 14.

---

## 1. Sintesi

**WORLDBUG** è un gioco browser single-player di *scienza sul campo* ambientato in biosfere aliene.
Il giocatore è un analista xenologico di una missione di rilevamento. Non controlla l'ecosistema:
lo **osserva**, lo **disturba** con un budget di energia limitato, ne **deduce** le leggi e infine
**deposita un rapporto** prima che la finestra di rilevamento si chiuda, senza distruggere la biosfera
studiata.

**Promessa in una frase:** *"Hai tre misure, un budget e un mondo che non capisci ancora. Scopri le sue leggi
prima che il tempo scada."*

**Piattaforma:** HTML5 statico (Canvas 2D + Web Audio), nessun backend, nessun account, nessuna rete
durante il gioco (vedi ADR-002 e `DESIGN.md` §9).

---

## 2. Pubblico

### 2.1 Pubblico primario
- **Giocatori di puzzle investigativi e di deduzione** (chi ama capire un sistema osservando indizi, con
  tensione da tempo limitato). Riferimento di genere: giochi in cui si deduce un sistema nascosto
  attraverso l'osservazione, non attraverso i tutorial.
- **Giocatori di simulazione “a basso controllo”**: chi gode dei sistemi emergenti ma si stanca dei
  gestionali con troppi pulsanti.
- Età indicativa 18–45, giocatori PC e browser, disposti a una sessione di 20–40 minuti per settore.

### 2.2 Pubblico secondario
- **Studenti e insegnanti** di biologia / ecologia delle scuole superiori e primo anno universitario: il
  gioco insegna metodo (campioni, variabili, controlli, dati) più che nozioni. *[IPOTESI da aggiungere alla sezione 14]*
- **Giocatori con disabilità visiva** che usano screen reader: il gioco è progettato per esserlo (ADR-007),
  ma è un pubblico da validare, non da assumere.

### 2.3 Non è per
- Chi cerca controllo diretto su un esercito o una colonia (il gioco nega questa fantasia di proposito).
- Chi cerca sessioni di 5 minuti senza memoria tra una partita e l'altra.

---

## 3. Genere e posizionamento

- **Genere:** simulazione di sistemi + deduzione scientifica + strategia a risorse limitate.
- **Formato:** missioni a settori (5 nella campagna), ciascuna con una finestra di tempo fissa (2600–3600
  tick), un budget di carica, un rapporto finale valutato.
- **Tono:** sobrio, da documento d'archivio di una missione. Niente umorismo forzato, niente narrativa
  cinematografica. La storia è implicita nei dati dei settori.

---

## 4. Fantasia del giocatore

| Fantasia | Descrizione | Come si sente nel gioco |
|---|---|---|
| **Lo scienziato che capisce** | “Ho misurato, ho ipotizzato, la misura ha confermato.” | Un dato sul pannello Dati cambia la tua ipotesi. |
| **Il sopralluogo prudente** | “Non ho rovinato il posto che studiavo.” | Lo score di conservazione premia la biosfera viva. |
| **Il responsabile di missione** | “Ho speso il budget con criterio.” | Ogni Carica spesa deve valere un'informazione. |
| **Il mondo che non è mio** | “Esiste, ha regole sue, e non si piega ai miei desideri.” | La simulazione reagisce anche quando sbagli. |

**Emozione da evitare:** la sensazione di “aver indovinato a caso” o di “non aver potuto sapere”. Ogni
proposizione del Codex deve essere verificabile con gli strumenti del settore (garanzia di equità, §5.4).

---

## 5. Ciclo principale

### 5.1 Ciclo di tick (il gioco come macchina)
Ogni tick: campi ambientali → percezione → alimentazione → metabolismo → movimento → riproduzione → morte
(con causa registrata). Dettagli in `DESIGN.md` §3.2. Il giocatore vede il risultato come popolazioni,
biomassa, eventi, probe.

### 5.2 Ciclo di missione (il gioco come esperienza)

```
 OSSERVA ──► DISTURBA ──► MISURA ──► IPOTIZZA ──► DEPOSITA
  (tempo)    (Carica,      (probe,      (rispondi      (rapporto,
             Integrità)    Dati,        alle           voto S…F)
                           Registro)    proposizioni)
     ▲                                                   │
     └──────────── se la finestra non è scaduta ◄────────┘ (rapporto parziale non ammesso)
```

Passi tipici di un giocatore in FER-1 (primo settore), stimati:
1. Leggere la mappa dei campi di temperatura, umidità, luce: dove la vita si addensa?
2. Attivare un probe in una zona ricca e uno in una zona vuota.
3. Osservare il Registro: cause di morte (esposizione, fame, vecchiaia, predazione).
4. Usare un Impulso Termico o Criogenico per testare un'ipotesi di tolleranza. Il disturbo decade: è una misura.
5. Spendere Carica in un Data Assist per ottenere statistiche reali su una proposizione.
6. Rispondere alle proposizioni con un grado di confidenza e depositare il rapporto.

### 5.3 Ciclo di sessione
Avvio settore → briefing → missione → rapporto → debriefing per proposizione → ritorno alla mappa dei
settori. Il progresso è salvato in `localStorage` alla fine di ogni azione rilevante.

### 5.4 Equità del Codex (invariante di design)
Ogni proposizione è **derivata dai parametri nascosti** della simulazione e **auditata in codice**
(`src/content/law-fairness.ts`, ADR-005 e ADR-008). Il test di equità verifica che un “scienziato ideale”
scriptato, con la Carica del settore, possa distinguere la risposta corretta dai distrattori.
**[IPOTESI H2]:** questo invariante vale per il codice; non è ancora dimostrato che valga per un giocatore umano.

---

## 6. Azioni del giocatore

### 6.1 Strumenti di rilevamento (gratuiti)
| Strumento | Funzione | Scelta di design |
|---|---|---|
| Overlay campi | Mostra temperatura, umidità, luce, biomassa | Lo strumento principale per leggere la geografia |
| Scanner organismi | Ispezione di un singolo organismo | Dà dati puntuali, non leggi |
| Probe (N limitati) | Campionano campi e conteggi per raggio nel tempo | Dati da cui nasce ogni deduzione |
| Registro eventi | Nascite, morti con causa, predazioni, picchi di pascolo, impulsi | La prova più importante |

### 6.2 Strumenti sperimentali (costano Carica; alcuni anche Integrità)
| Strumento | Carica | Integrità | Effetto |
|---|---|---|---|
| Impulso Termico / Criogenico | 2 | 0 | ±Δ temperatura nel raggio, con decadimento |
| Umidificatore / Disidratatore | 2 | 0 | ±Δ umidità |
| Illuminatore / Campo d'Ombra | 2 | 0 | ±Δ luce |
| Bloom di Nutrienti | 3 | 0 | Biomassa istantanea per i produttori |
| Barriera di Contenimento | 3 | 1 | Blocca il movimento su una linea |
| Onda di Sfoltimento | 4 | 6 | Rimuove organismi nel raggio (distruttivo) |
| Incubatrice | 5 | 2 | Introduce individui di una specie scelta |

**Nota:** `REGISTRY.md` riporta 10 strumenti, in linea con la tabella sopra. Il conteggio va riverificato nel
codice prima della pubblicazione. *(Vedi sezione 15, D4.)*

### 6.3 Analisi
- **Data Assist** (costo: 3 Carica per proposizione): calcola statistiche reali sui dati già raccolti
  (probe ed eventi), con n campionario. Non dà mai la risposta.

### 6.4 Azioni di consegna
- Rispondere a una proposizione con un'opzione o “sconosciuto”, con confidenza.
- Depositare il rapporto (azione *File*). Ammesso solo se la biosfera è viva.

---

## 7. Specie

Il catalogo ha **12 specie** in 5 settori. Ogni specie ha tratti visibili (ruolo trofico, nicchia termica,
velocità) e **parametri nascosti** (ottimo termico/umido/luminoso, dipendenze, comportamento allo stress)
che il giocatore deve dedurre.

| Codice | Nome | Ruolo | Note di design |
|---|---|---|---|
| AUR-3 | Aurelia thermica | Autotrofo | Produttore principale della campagna (dal GDD v1: caldo e umido) |
| FER-7 | Ferrax repens | Brucatore | Primo consumatore; legge di tolleranza in FER-1 |
| KEL-2 | Kelpia umbrosa | Autotrofo | Autotrofo freddo e poco illuminato (dal registro del progetto) |
| VEL-5 | Vellum vagans | Brucatore, migratore | Brucatore con comportamento migratorio |
| ORS-9 | Orsax vorax | Predatore | Prima prova di predazione (KEL-4) |
| VOX-1 | Voxa lucida | Autotrofo | Nicchia di luce intensa |
| SCU-4 | Scuta | Brucatore | Pascolo in penombra |
| MYC-8 | Mycorrhiza pallens | Filtratore | Vive senza luce; ciclo dei nutrienti |
| ORP-6 | Orpa ustulata | Autotrofo | Autotrofo caldo; presente nel settore ORP-2 |
| CAL-5 | Calyx fervens | Brucatore | Muore per esposizione (`perish`) |
| GLI-3 | Glirra | Predatore | Predatore di pascolatori; pressione sulla rete |
| TAU-0 | Tauros invadens | Generalista invasivo | Il “nuovo arrivato” di TAU-7 |

**Principio di design:** ogni specie deve essere deducibile da almeno due indizi indipendenti (per esempio
la temperatura alla morte *e* la dieta osservata). *[IPOTESI H3]*

**Ruoli della rete trofica:** produttori (energia dalla luce, temperatura e umidità), brucatori (dipendono
dalla biomassa dei produttori), predatori (dipendono dalle prede), filtratori e generalisti (casi limite
che testano la comprensione). Gli spazzini chiudono il ciclo dei nutrienti (ADR-009), con ruolo limitato.

---

## 8. Condizioni ambientali

### 8.1 Campi
| Campo | Intervallo | Effetto principale |
|---|---|---|
| Temperatura | 150–450 K | Tolleranza termica; esposizione letale oltre soglia |
| Umidità | 0–1 | Tolleranza idrica; fotosintesi dei produttori |
| Luce | 0–1 | Fotosintesi; nicchia dei produttori e delle specie in penombra |

### 8.2 Sorgenti e geografia
Le **sorgenti di terreno** (sfiati termici, sorgenti criogeniche, bacini di nebbia, luminari di cristallo,
canyon d'ombra) spingono i campi verso un valore locale con decadimento radiale. La geografia è il primo
indizio: il giocatore impara a *leggere la mappa* prima di leggere i numeri.

### 8.3 Impulsi e variazioni nel tempo
- Alcuni settori hanno un **impulso periodico** (KEL-4 *roof-flare*, ORP-2 *meridian-surge*): un'ondata di
  calore cambia temporaneamente ciò che significa “prosperare”. È la prima meccanica che richiede di
  distinguere una risposta transitoria da una legge.
- Gli impulsi del giocatore decadono verso la base: sono **misure, non modifiche permanenti** (DESIGN §4.2).

### 8.4 Scelte di design sulle condizioni
- Le condizioni sono **continue e leggibili** sulla mappa; non esistono “stagioni” cieche.
- Il sistema non è mai in equilibrio perfetto: la varietà geografica garantisce che ogni settore abbia
  nicchie diverse da sfruttare.

---

## 9. Vittoria, sconfitta, valutazione

### 9.1 Valutazione del rapporto (implementata, `DESIGN.md` §6)
```
correttezza  = pesi delle proposizioni corrette / totale          (0..1)
conservazione = f(biomassa finale vs banda obiettivo, estinzioni)  (0..1)
efficienza   = 1 − Carica spesa / Carica iniziale × 0.5            (0.5..1)
punteggio    = 1000 × correttezza^1.3 × (0.6 + 0.25·conservazione + 0.15·efficienza)
rango        = S ≥ 900 · A ≥ 750 · B ≥ 550 · C ≥ 1 · F altrimenti
```

### 9.2 Vittoria
- **Vittoria di settore:** rapporto depositato con rango **C o superiore** (almeno un punto), biosfera
  viva. Sblocca il settore successivo.
- **Vittoria piena:** rango **S** o **A**, cioè correttezza alta e biosfera conservata.

### 9.3 Sconfitta
- **Fine della finestra senza rapporto:** il rapporto viene depositato automaticamente; le proposizioni
  senza risposta contano come errate.
- **Collasso della biosfera** (tutte le specie estinte): il rapporto è **rifiutato**. Non esiste un rango
  per un mondo morto.

### 9.4 Discrepanze da risolvere (vedi sezione 15)
- **[PROPOSTA — regola di sconfitta]** `DESIGN.md` §6 dice “rango C altrimenti”, ma il codice (`grading.ts`)
  assegna `F` a un punteggio inferiore a 1. Il codice è più coerente con un fallimento esplicito. Il GDD
  propone di tenere `F` come rango di fallimento e di aggiornare `DESIGN.md`.
- **[PROPOSTA — collasso]** Il codice rifiuta il rapporto ma non definisce una schermata di fallimento
  né un percorso di nuovo tentativo. Un giocatore può trovarsi bloccato. Proposta: schermata “Missione
  fallita” con cause di morte, e pulsante “Ripeti settore” che non cancella i ranghi già ottenuti.

---

## 10. Difficoltà

### 10.1 Leve di difficoltà già presenti (per settore)
- **Carica iniziale** (10–15 nella campagna): più Carica significa più esperimenti.
- **Finestra di tempo** (2600–3600 tick): più tempo significa meno pressione.
- **Strumenti disponibili** (FER-1 ne ha pochi; TAU-7 li ha tutti).
- **Numero di proposizioni** (5–7 per settore) e pesi (0.6–1.4).
- **Impulsi periodici** (KEL-4, ORP-2).

### 10.2 Difficoltà proposta [PROPOSTA]
Tre preset, implementati come moltiplicatori sui parametri esistenti (non come nuove regole):

| Preset | Carica | Finestra | Costo Data Assist | Altro |
|---|---|---|---|---|
| **Osservatore** | +30 % | +25 % | 2 Carica | Hint di equità disponibile (solo “ragionevole”) |
| **Ricercatore** | valore di settore | valore di settore | 3 Carica | Predefinito |
| **Missione difficile** | −20 % | −15 % | 4 Carica | Nessun Data Assist sulle proposizioni di predazione |

Questo non richiede nuova logica di simulazione. Richiede però che l'audit di equità (`law-fairness.ts`)
venga rieseguito per ogni preset, perché un preset più duro potrebbe rendere un settore non equo.

---

## 11. Progressione

### 11.1 Campagna (implementata)
Cinque settori in ordine: FER-1 → KEL-4 → VOX-9 → ORP-2 → TAU-7. Ogni settore sblocca il successivo con un
rango diverso da F (il codice in `app.ts`). Le nuove meccaniche arrivano una alla volta:

| # | Settore | Nuova meccanica | Carica | Finestra |
|---|---|---|---|---|
| 1 | FER-1 Cinder Shelf | Lettura dei campi, prima legge di tolleranza | 10 | 2600 |
| 2 | KEL-4 Vault Basin | Predazione, prova di uccisione | 12 | 3000 |
| 3 | VOX-9 Lumen Reef | Luce come asse di nicchia, pressione di pascolo | 13 | 3200 |
| 4 | ORP-2 Ashfall | Impulso periodico, migrazione | 15 | 3600 |
| 5 | TAU-7 Ghost Meridian | Specie invasiva, diagnosi di un mondo in collasso | 15 | 3600 |

### 11.2 Progressione del giocatore
- Il **profilo** salva settori sbloccati e ranghi (`localStorage`, chiave `worldbug.save`). Nessun account.
- Il pulsante **Reset profile** cancella tutto (già presente).
- Non esistono ancora valute, sblocchi di strumenti o potenziamenti. La progressione è solo narrativa e di
  campagna.

### 11.3 Progressione proposta post-lancio
- **Archivio dei rapporti:** collezione dei rapporti migliori con le leggi scoperte, come “Codex”.
- **Sbloccabili di strumento** legati alla campagna, non a valute.
- **Modalità Rilevamento libero** con seed condivisibile (vedi 13.3).

---

## 12. Differenziazione

### 12.1 Confronto con i riferimenti

| Gioco | Cosa fa | Dove WORLDBUG si differenzia |
|---|---|---|
| **Niche — a genetics survival game** (Stray Fawn) | Il giocatore guida una tribù animale, alleva, sopravvive a predatori e malattie, con genetica realistica e più di 100 geni. È descritto come gioco a turni con elementi roguelike e il successo è sopravvivenza della specie [1][2]. È usato anche nelle scuole per insegnare la genetica [10]. | Niche si basa sul **controllo diretto** di una specie. WORLDBUG non dà controllo: il giocatore è uno **scienziato esterno**. Niche insegna la genetica con la pratica; WORLDBUG mette la **deduzione di regole** e la **valutazione** al centro. |
| **Simulatori di ecosistema su itch.io** | Simulatori sandbox dove si regolano parametri (crescita, metabolismo, predatori, disastri) e si osserva l'evoluzione, per esempio [MauroDot](https://maurodot.itch.io/ecosystem-simulator) e [Lluís Vinent](https://lluisv.itch.io/organism-simulation). Il tema del sim-jam di itch.io include esplicitamente il formato “osservazione passiva” [3]. | Questi strumenti non hanno **obiettivo verificabile**, né **deduzione** né **rapporto valutato**. WORLDBUG aggiunge il vincolo di budget e la domanda “quali sono le leggi?”. |
| **Giochi di deduzione** (genere investigativo) | Il giocatore ricostruisce un sistema nascosto da indizi. | WORLDBUG applica la stessa logica a una **biosfera simulata**, con regole generate dalla simulazione e non scritte a mano. Ogni risposta corretta è garantita dall'audit, non dall'autore. |

### 12.2 Differenziatori sostenibili
1. **Verità generata:** le leggi sono derivate dai parametri reali della simulazione, quindi non possono
   contraddire lo schermo. Non ho trovato, nella ricerca fatta per questo GDD, un gioco di riferimento
   che faccia lo stesso; la verifica di questa affermazione resta da completare (vedi sezione 14).
2. **Budget come domanda:** ogni strumento costa Carica e Integrità. Lo spreco si vede nel punteggio.
3. **Conservazione come valore:** un rapporto perfetto su un mondo morto non vale nulla.
4. **Browser puro, nessun server:** si gioca senza installazione, senza account, senza analytics.

### 12.3 Rischi di differenziazione
- Un pubblico abituato al controllo potrebbe vedere il gioco come “tedioso”. *[IPOTESI H1]*
- Un giocatore che vuole solo sandbox può trovare la valutazione inutile. *[IPOTESI H6]*

---

## 13. Ambito del prodotto

### 13.1 MVP (prima build pubblicabile)
L'MVP è la build attuale (già giocabile, con 161 test verdi) più un numero ristretto di correzioni.

**Già presente nel codice:**
- Simulazione deterministica con 12 specie e 5 settori.
- Strumenti (10), probe, registro, Data Assist.
- Codex con 31 proposizioni auditate.
- Valutazione, ranghi, persistenza, UI accessibile, rendering Canvas, audio sintetico.

**Da completare per l'MVP:**
1. **Schermata di fallimento** e percorso di ripetizione per il collasso (sezione 9.4). *Obbligatorio.*
2. **Allineamento delle regole** tra `DESIGN.md` e `grading.ts`: rango F. *Obbligatorio.*
3. **Briefing del tutorial** per FER-1. La documentazione descrive `src/content/tutorial.ts`, ma il file non
   esiste. Va creato o la documentazione va corretta. *Obbligatorio.*
4. **Playtest reale** con almeno 5 persone su FER-1 e 3 su KEL-4 (vedi sezione 14). *Obbligatorio per decidere.*
5. **Decisione sulla lingua dei testi** (vedi sezione 15, D5). *Obbligatorio.*
6. **Verifica del conteggio degli strumenti** (10 nel registro, rivedere il codice). *Obbligatorio, costo basso.*

### 13.2 Post-lancio
- Difficoltà a tre livelli (sezione 10.2), con audit di equità per preset.
- Localizzazione italiana (se la decisione va in quella direzione).
- Archivio dei rapporti e modalità Rilevamento libero con seed condivisibile.
- Settori 6+ con nuove meccaniche (per esempio una specie che evolve un tratto durante la missione).
- Accessibilità aggiuntiva, con playtest con utenti di screen reader.
- Versione per portali HTML5 (`PORTAL.md`, checklist già citata in `ARCHITECTURE.md`, oggi mancante).

### 13.3 Idee opzionali (non impegnate)
- **Seed giornaliero** senza server: tutti giocano lo stesso mondo, si confrontano i ranghi localmente.
- **Editor di settore** per insegnanti (configurazione di sorgenti e specie tramite JSON validato).
- **Modalità didattica** con note esportabili come CSV dai probe.
- **Modalità cooperativa a turni** su un solo schermo.
- **Evoluzione delle specie** tra settori (richiede ADR nuovo, forte impatto su equità).

---

## 14. Ipotesi da verificare con i giocatori

Le ipotesi sono ordinate per rischio. Ogni ipotesi ha un metodo di verifica osservabile, senza analytics
(vedi non-goal in `DESIGN.md` §9). I test si fanno con osservazione diretta e note.

| ID | Ipotesi | Come verificarla | Risultato che la conferma | Risultato che la smentisce |
|---|---|---|---|---|
| **H1** | Osservare senza controllare tiene il giocatore impegnato | Playtest FER-1 con 5 persone, osservazione del tempo di gioco | ≥ 4 su 5 completano il settore senza abbandonare, sessione 15–25 min | Abbandoni nei primi 10 minuti |
| **H2** | Le leggi di tolleranza sono deducibili solo con i campi e i probe | Playtest senza Data Assist, poi con | ≥ 60 % risponde correttamente alle proposizioni di tolleranza in FER-1 senza Data Assist | Risposte corrette solo con Data Assist |
| **H3** | Ogni specie è deducibile da due indizi indipendenti | Revisione delle risposte errate e del registro | Gli errori si concentrano su proposizioni con un solo indizio | Errori diffusi su tutte le proposizioni |
| **H4** | Il budget di Carica crea scelte significative | Osservazione di come i giocatori spendono la Carica | Strategie diverse tra giocatori, più di un tipo di strumento usato | Tutti spendono allo stesso modo |
| **H5** | L'Onda di Sfoltimento è usata come esperimento, non per frustrazione | Osservazione dell'uso, domanda a fine sessione | Usata come test controllato e poi motivata | Usata per “ripulire” il mondo |
| **H6** | Il rango come gate di progressione non frustra | Osservazione dopo il primo F | Chi ottiene F riprova senza uscire | Abbandono dopo F |
| **H7** | Le proposizioni sono comprensibili a un non biologo | Lettura delle proposizioni con persone non del campo | Comprensione senza spiegazioni esterne | Termini tecnici non compresi |
| **H8** | I giocatori percepiscono le proposizioni come giuste | Domanda a fine sessione su “avevo le informazioni per saperlo?” | ≥ 70 % risponde sì | Sensazione di risposta a caso |
| **H9** | La lingua italiana è preferita per il pubblico target | Test A/B con due versioni, o questionario a 10 persone | Preferenza chiara per una lingua | Preferenza equivalente |
| **H10** | Il gioco gira a 60 fps su un portatile di fascia media | Misura del tempo di frame in browser reale | ≥ 55 fps medi su FER-1 e TAU-7 | Frame cadenti con più di 200 organismi |
| **H11** | Un utente di screen reader può completare FER-1 | Test con un utente reale | Completamento con pochi aiuti | Blocchi sulla mappa |
| **H12** | I giocatori tornano a giocare dopo il primo settore | Osservazione del ritorno nei giorni successivi | ≥ 2 settori completati da un terzo dei giocatori | Abbandono dopo FER-1 |
| **H13** | La velocità di simulazione non frustra in TAU-7 | Osservazione dei ritmi di gioco sul settore più pesante | Nessun abbandono per lentezza | Lamentele sul ritmo |

**Nota:** il registro (`REGISTRY.md`, punto 7) riconosce che solo FER-1 è stato giocato a mano. H1, H2, H6
e H13 sono il primo gruppo da verificare.

---

## 15. Discrepanze e decisioni richieste

| # | Discrepanza | Fonte | Azione proposta |
|---|---|---|---|
| D1 | Rango minimo `C` (docs) contro rango `F` (codice) | `DESIGN.md` §6 vs `grading.ts` | Tenere `F` e aggiornare `DESIGN.md` |
| D2 | Collasso rifiuta il rapporto ma non ha schermata di fallimento | `session.ts` `file()` | Aggiungere schermata e ripetizione |
| D3 | Tutorial documentato ma assente | `ARCHITECTURE.md` vs `src/content/` | Creare o rimuovere dalla documentazione |
| D4 | Conteggio strumenti: 10 nei docs, da riverificare nel codice | `REGISTRY.md` | Verificare e correggere |
| D5 | Lingua dei testi: inglese nel codice, italiano nella richiesta | `REGISTRY.md` punto 9 | **Decisione del proprietario** |
| D6 | Licenza citata ma assente | `package.json` | **Decisione del proprietario** |
| D7 | Nome del repository SOLDI, progetto WORLDBUG | repository | **Decisione del proprietario** |

---

## 16. Fonti

1. Niche, pagina Kickstarter, descrizione del gioco: [kickstarter.com](https://www.kickstarter.com/projects/80250451/niche-a-genetics-survival-game)
2. Niche, pagina Steam con descrizione e tag: [store.steampowered.com](https://store.steampowered.com/app/440650/Niche__a_genetics_survival_game/)
3. The Sim-Jam #1, tema “Ecosistemi”, formato di osservazione passiva e interattivo: [itch.io](https://itch.io/jam/the-sim-jam-1-ecosystems)
4. Ecosystem Simulator, MauroDot, simulatore sandbox con parametri regolabili: [maurodot.itch.io](https://maurodot.itch.io/ecosystem-simulator)
5. Organism Simulation, Lluís Vinent, simulatore con osservazioni su popolazioni e predatori: [lluisv.itch.io](https://lluisv.itch.io/organism-simulation)
6. Niche, uso educativo nelle scuole e riferimento alla genetica di popolazione: [pcgamer.com](https://www.pcgamer.com/niche-is-a-cute-genetics-survival-game-thats-now-free-for-schools/)

*Le fonti 1–6 documentano il panorama dei riferimenti. Le affermazioni sul design di WORLDBUG derivano da
`docs/DESIGN.md` e dal codice. Non sono stati fatti test di mercato.*

---

## Appendice A — Glossario

- **Tick:** unità di tempo discreta della simulazione.
- **Carica (Charge):** budget di energia per gli strumenti sperimentali.
- **Integrità:** budget di danno all'ecosistema; alcuni strumenti la consumano.
- **Probe:** sensore che registra campi e conteggi nel tempo.
- **Data Assist:** analisi statistica a pagamento sui dati già raccolti.
- **Proposizione:** affermazione del Codex su una legge del mondo, con una risposta corretta derivata dal modello.
- **Rango:** voto del rapporto (S, A, B, C, F).
- **Biosfera viva:** almeno una specie con popolazione maggiore di zero.
