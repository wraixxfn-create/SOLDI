# WORLDBUG — Core loop

> Stato: **bozza v1.0**. Complementa `docs/GDD.md` (visione) e `docs/DESIGN.md` (regole implementate).
> Ogni numero è stato letto dal codice o dai docs, salvo dove è marcato **[DA VERIFICARE]**.
> Le proposte di cambiamento sono marcate **[PROPOSTA]**.

---

## 0. Fatti dal codice su cui si basa il ciclo

| Fatto | Valore | Fonte |
|---|---|---|
| Carica di partenza, FER-1 / KEL-4 / VOX-9 / ORP-2 / TAU-7 | 10 / 12 / 13 / 15 / 16 | `src/content/sectors.ts` |
| Integrità di partenza, stessi settori | 12 / 12 / 15 / 16 / 20 | `src/content/sectors.ts` |
| Finestra di rilevamento (tick), stessi settori | 2600 / 3000 / 3200 / 3600 / 3600 | `src/content/sectors.ts` |
| Strumenti in FER-1 | thermal, cryo, humidifier, desiccator, nutrient (5) | `sectors.ts` |
| Costi Carica / Integrità | Impulsi 2/0, Bloom 3/0, Barriera 3/1, Sfoltimento 4/6, Incubatrice 5/2 | `src/game/instruments.ts` |
| Data Assist | 3 Carica per proposizione | `REGISTRY.md` e `DESIGN.md` §4.3 |
| Proposizioni per settore | 5 / 6 / 6 / 7 / 7 | `REGISTRY.md` |
| Decadimento del campo verso la base | `DEFAULT_RELAXATION = 0.0035` per tick | `src/core/sim/sector.ts` |
| Peso dell'efficienza nel punteggio | `0.15 × efficienza`, con efficienza in 0.5…1 | `DESIGN.md` §6, `grading.ts` |
| Peso della correttezza | `correttezza^1.3`, dominante | `DESIGN.md` §6 |

**Tre fatti che cambiano il ciclo** (dettaglio in §6):
1. Nel codice l'Integrità limita solo gli strumenti. **Non entra nel punteggio.**
2. Il controllo di disponibilità degli strumenti confronta il **costo in Carica** con il **tempo rimanente**
   (`session.ts` passa `remainingTicks` al parametro chiamato `remainingCharge`). È un bug, vedi §6.2.
3. Il seed di ogni settore è fisso (`seed: 0x5eed_…`). Un mondo è sempre lo stesso per quel settore.

---

## 1. Il loop in una frase

> **Ogni esperimento è una domanda: “se cambio X in questo punto, cosa succede a Y nel tempo?”**
> Il giocatore paga in Carica per fare la domanda, osserva la risposta che il mondo dà e la usa per
> rispondere a una proposizione del Codex.

### 1.1 Test dei 10 secondi

Il giocatore deve capire in 10 secondi, guardando lo schermo:
- **Cosa vedo:** una mappa colorata (temperatura) con organismi.
- **Cosa posso fare:** scegliere uno strumento e cliccare un punto.
- **Cosa perdo:** Carica (un numero che scende).
- **Cosa devo fare:** rispondere alle domande del Codex prima che il tempo finisca.

Se uno di questi quattro punti non è chiaro dopo 10 secondi, il loop non è riuscito. La prova va fatta con
persone che non hanno letto nulla (vedi §9).

### 1.2 Perché questo loop richiede ragionamento

Il giocatore non conosce le regole. Vede solo effetti. Per capire una legge deve:
- distinguere **correlazione** da **causa** (la specie è dove fa freddo, o fa freddo dove c'è la specie?);
- tenere conto del **ritardo** (un impulso decade, quindi va misurato subito);
- accettare il **rumore** (gli organismi sono individui, non un numero);
- scegliere **dove** misurare, perché la geografia conta (§5).

Il gioco non è difficile perché l'interfaccia è complessa. È difficile perché le domande vanno formulate bene.

---

## 2. Le sei fasi

| # | Fase | Domanda del giocatore | Input | Output del sistema | Decisione chiave | Tempo tipico |
|---|---|---|---|---|---|---|
| 1 | **Osservare** | “Dove vive questa specie?” | Overlay campi, scanner, orologio | Mappa, popolazioni, Registro | Dove guardare | 2–5 min all'inizio |
| 2 | **Formulare ipotesi** | “Che legge potrebbe spiegare questo?” | Osservazioni di fase 1 | Nessun effetto diretto (vedi §3) | Quale domanda porsi | Pensiero, non tempo di gioco |
| 3 | **Scegliere l'esperimento** | “Quale test separa le due ipotesi, al minimo costo?” | Strumenti, Carica, Integrità, tempo | Costo previsto (Carica, Integrità) | Strumento, luogo, raggio, momento | 1–2 min per esperimento |
| 4 | **Eseguire** | “Cosa succede?” | Click sulla mappa, Invio | Impulso o effetto, poi evoluzione nel tempo | Quanto attendere (tick) | Da 200 a 500 tick per una risposta |
| 5 | **Interpretare** | “Il risultato conferma o smentisce l'ipotesi?” | Probe, Registro, Data Assist | Serie storiche, statistiche con n | Quanto fidarsi del dato | 1–3 min |
| 6 | **Applicare** | “A quale proposizione risponde questo dato?” | Codex | Risposta con confidenza, correttezza a fine missione | Quale proposizione, quale confidenza | Quando il dato è sufficiente |

Il ciclo si ripete. Ogni giro dovrebbe rispondere ad almeno una proposizione, o restringere il campo di una.

---

## 3. Ipotesi: dove vive oggi nel gioco

Nel codice non esiste un luogo dove il giocatore scrive un'ipotesi prima di sperimentare. L'ipotesi esiste
solo nella testa del giocatore, con due sostituti:
- **Il Codex:** rispondere a una proposizione con una confidenza è già un'ipotesi esplicita. Ma arriva solo
  alla fine, quindi non guida gli esperimenti.
- **Il Registro:** mostra gli eventi passati, non le ipotesi future.

**[PROPOSTA] Taccuino di ipotesi.** Un pannello leggero, opzionale, dove il giocatore annota per una specie:
“credo che X prosperi con Y alto / basso”. Caratteristiche:
- **nessun effetto sul punteggio**: serve solo a rendere visibile il ragionamento;
- **nessun costo**;
- può essere confrontato con i dati: il gioco mostra quante misure lo sostengono o lo contraddicono (con n),
  senza dire se è giusta. Questo è un Data Assist diverso, non una risposta;
- la sua esistenza rende possibile il test di H-loop-2 (§9).

Rischio: se il taccuino dà già la risposta, il Codex diventa banale. Il taccuino deve restare un'annotazione,
non una validazione.

---

## 4. Economia degli esperimenti

### 4.1 Costi per tipo

| Azione | Carica | Integrità | Tempo | Cosa compra |
|---|---|---|---|---|
| Probe (osservazione) | 0 | 0 | Per tutta la finestra | Serie storica di campi e conteggi nel raggio |
| Impulso Termico / Criogenico | 2 | 0 | Decade in circa 200 tick [DA VERIFICARE] | Risposta a un cambio di temperatura |
| Umidificatore / Disidratatore | 2 | 0 | Idem | Risposta a un cambio di umidità |
| Illuminatore / Ombra | 2 | 0 | Idem | Risposta a un cambio di luce |
| Bloom di Nutrienti | 3 | 0 | Istantaneo | Test di dipendenza dalla base alimentare |
| Barriera | 3 | 1 | Finché esiste | Test di migrazione o isolamento |
| Sfoltimento | 4 | 6 | Istantaneo | Test di dipendenza da una specie, ma costoso |
| Incubatrice | 5 | 2 | Immediato | Introduzione di una specie per testare competizione o nicchia |
| Data Assist | 3 per proposizione | 0 | Istantaneo | Statistica sui dati già raccolti, con n |

### 4.2 Il costo vero: opportunità

Il costo di una Carica non è il suo valore numerico, ma la domanda che non si può più fare. Esempio su FER-1
(10 Carica, 5 proposizioni, come da `REGISTRY.md`):

| Piano | Spesa | Cosa lascia senza risposta |
|---|---|---|
| A. Tre Data Assist (9 Carica) | 9 | Due proposizioni senza dato sperimentale, solo con probe |
| B. Cinque impulsi da 2 | 10 | Nessun Data Assist: le risposte vanno dedotte dai soli impulsi |
| C. Due Data Assist + due impulsi (10) | 10 | Una proposizione senza Data Assist, due esperimenti |
| D. Un Data Assist + tre impulsi (9) | 9 | Quattro proposizioni, meno dati, più dipendenza dal probe |

Nessun piano è dominante. La scelta dipende da quali proposizioni il giocatore ritiene facili o difficili da
dedurre. Questo è il primo punto di decisione interessante (§5.1).

### 4.3 Il costo in punteggio è piccolo (dato importante)

Dal punteggio (`DESIGN.md` §6):
- Spendere tutta la Carica porta l'efficienza da 1 a 0.5. Il moltiplicatore cala di `0.15 × 0.5 = 0.075`.
  Con correttezza e conservazione piene, il punteggio perde al massimo **7,5 %**.
- Una sola proposizione sbagliata su 5 (pesi uguali) porta la correttezza a 0.8, e `0.8^1.3 ≈ 0.75`.
  Il punteggio perde circa **25 %**.

**Conseguenza:** nel codice la Carica pesa molto meno della conoscenza. Il giocatore è incentivato a spendere
tutto per sapere, non a risparmiare. Questo rende il budget una scelta di *cosa* sapere, non di *quanto*
spendere. È coerente con la fantasia dello scienziato, ma non con la fantasia del “responsabile di missione”
(GDD §4). **[PROPOSTA]:** vedi §6.1.

---

## 5. Decisioni interessanti

### 5.1 Criteri
Una decisione è interessante quando:
1. ci sono **almeno due opzioni plausibili**;
2. il risultato dipende da qualcosa che il giocatore **non conosce ancora**;
3. il giocatore può **rendersi conto dopo** se ha scelto bene (feedback leggibile).

### 5.2 Le sei decisioni principali

| # | Decisione | Opzioni | Tensione | Feedback |
|---|---|---|---|---|
| D1 | **Quale proposizione assistere** | Pagare 3 Carica per una proposizione difficile, o dedurla con probe | Costo certo contro informazione incerta | Il Data Assist mostra n; se n è basso, il dato è debole |
| D2 | **Dove mettere il probe** | Zona ricca (dati densi, ma niente contrasto) o zona al limite (contrasto, ma pochi organismi) | Rumore contro segnale | Dopo qualche centinaio di tick, il grafico mostra se la differenza è reale |
| D3 | **Quale impulso** | Termico o criogenico? Stesso raggio? | Ipotesi su temperatura o su umidità | Se la popolazione sale o scende, l'ipotesi si restringe |
| D4 | **Quando misurare** | Subito dopo l'impulso (campo ancora alto) o dopo circa 200 tick (campo a metà strada, se il decadimento è esponenziale [DA VERIFICARE]) | Forza del segnale contro effetto demografico lento | Il campo decade: misurare tardi significa non vedere nulla |
| D5 | **Sfoltire o aspettare** | Sfoltimento a 4 Carica e 6 Integrità, o attesa | Informazione immediata contro danno duraturo | Il Registro conta le morti per causa e mostra l'effetto |
| D6 | **Quando depositare** | Subito, con le risposte disponibili, o attendere per dati migliori | Sicurezza contro tempo | La finestra scade e le risposte mancanti contano come sbagliate |

### 5.3 Esempio di decisione che fallisce (da evitare)
Se un solo strumento è sempre la scelta migliore (per esempio l'impulso termico per qualsiasi domanda), il
loop non richiede ragionamento. Per questo il set di strumenti di FER-1 (5) e di TAU-7 (tutti i 10) deve
includere risposte diverse per domande simili. **[DA VERIFICARE]** con playtest: se la maggioranza usa lo
stesso strumento, D3 è rotta.

---

## 6. Problemi nell'economia attuale

### 6.1 L'efficienza pesa poco
Vedi §4.3. Proposta: portare il peso dell'efficienza da `0.15` a `0.25`, riducendo di conseguenza la
conservazione o la correttezza. Oppure lasciare il peso e rendere la Carica più scarsa nei settori successivi.
Decisione del proprietario, con analisi di bilanciamento prima di cambiare il codice.

### 6.2 Bug: controllo di disponibilità degli strumenti
`session.ts` chiama `checkAffordable(config, budget, instrument, this.remainingTicks)`. In `instruments.ts`
il quarto parametro si chiama `remainingCharge` e il controllo è:

```
if (remainingCharge !== undefined && instrument.charge > remainingCharge) → blocca
```

Quindi confronta il costo in Carica (2–5) con i tick rimanenti. Oggi nella pratica non blocca quasi mai, ma il
messaggio dice “needs a larger survey window than remains”, che è la regola che si voleva. Il comportamento
voluto (un esperimento che richiede più tick di quelli che restano non può partire) non è implementato. Va
corretto con un parametro di durata dell'esperimento, oppure rimosso dal messaggio. **[DA VERIFICARE]** con un
test che fissi il comportamento atteso.

### 6.3 Integrità senza effetto sul punteggio
L'Integrità limita solo gli strumenti (`checkAffordable` controlla `budget.integrity`). Non compare nella formula
del punteggio (`grading.ts` non la usa). Quindi il costo dello Sfoltimento è solo un limite di accesso, non una
conseguenza. Per il giocatore è un costo in sé, ma non una scelta strategica: se ha Integrità, usa lo strumento.
**[PROPOSTA]:** o l'Integrità entra nella conservazione, o diventa un contatore con soglia (per esempio sotto il
20 % la missione è più difficile). Decisione di design.

### 6.4 Limite di probe non trovato
Il design dice “fino a N probe”, ma nel codice non ho trovato un limite. **[DA VERIFICARE]**: se non esiste, il
probe è gratuito e illimitato, e l'economia della fase 4 cade. Se esiste sotto un altro nome, va documentato.

---

## 7. Perché il giocatore dovrebbe ritentare

Un settore completato è un rapporto, un punteggio e un rango. Il motivo per riprovare non deve essere “fare
meglio” in astratto. Deve essere una domanda ancora aperta. I motivi concreti sono cinque.

### 7.1 Le risposte sbagliate sono le più istruttive
Il debriefing per proposizione (già presente, `DESIGN.md` §7) mostra quali risposte erano sbagliate. Il
giocatore sa che *c'era* una risposta e sa anche *quale* domanda avrebbe dovuto fare. Ritentare significa
fare la domanda giusta.

### 7.2 Il mondo è deterministico: l'esperimento è ripetibile
Il seed è fisso. Lo stesso settore produce sempre lo stesso mondo, e con le stesse azioni lo stesso risultato.
Questo permette qualcosa che nel mondo reale è difficile: **ripetere un esperimento senza rumore**. Il
giocatore può rifare esattamente la stessa mossa cambiando solo un parametro (il momento, il raggio, lo
strumento). È il vantaggio più forte del progetto per il core loop.

**Rischio:** se il giocatore memorizza il mondo, la seconda partita non richiede più ragionamento. Ci sono due
risposte possibili, da decidere:
- mantenere il seed fisso, accettando che la seconda partita sia più rapida ma più precisa;
- introdurre seed variabili per i ritentativi (post-lancio), che obbligano a ragionare di nuovo.

### 7.3 Lo score ha un gradino da salire
Il rango S (900) richiede correttezza alta e biosfera conservata: con efficienza e conservazione piene, serve correttezza di circa 0,92 o più (0,92^1,3 ≈ 0,90). Chi ha C o B sa cosa
manca. La differenza è spesso una o due proposizioni, non tutta la partita.

### 7.4 Il rango sblocca il settore successivo
Il settore successivo è chiuso fino al rango non-F (`app.ts`). Chi ha F ha un motivo immediato per riprovare.
Attenzione: se il rango F è raro, il gate non motiva; se è frequente, frustra. Va misurato (vedi §9).

### 7.5 Il Codex dà feedback su ogni risposta
Ogni proposizione ha una risposta vera e un debriefing. Il giocatore può tornare alle proposizioni che ha
sbagliato e cercare il dato che gli mancava. È un motivo diverso dal punteggio: la curiosità.

### 7.6 Cosa NON deve essere il motivo
- **Non** un bonus casuale: il mondo non deve cambiare per fare sorprese.
- **Non** una scorciatoia: un ritentativo non deve regalare le risposte.
- **Non** una lista di obiettivi secondari: il Codex è già l'obiettivo.

---

## 8. Esempio di ciclo completo (illustrativo)

> I numeri seguenti sono **illustrativi**. Non corrispondono ai parametri reali di FER-1, che vanno
> letti dal codice e misurati con `npm run trace`.

1. **Osservare.** Il giocatore vede che gli organismi di una specie si addensano nella zona più calda della
   mappa. Ha tre zone ipotetiche: calda, umida, luminosa.
2. **Ipotesi.** Ipotizza: la specie vuole il caldo. Annota nel taccuino (se presente).
3. **Scegliere.** Ha 10 Carica. Sceglie di testare il caldo con un impulso termico (2 Carica) e di misurare
   con un probe in una zona fredda, per confronto. Un Data Assist costerebbe 3 Carica e non potrebbe confermare
   un'ipotesi che non ha ancora formulato.
4. **Eseguire.** Attiva l'impulso. Aspetta 200 tick. Il campo decade, la popolazione vicina risponde lentamente.
5. **Interpretare.** Il probe nella zona fredda non si muove. Il Registro mostra morti per esposizione dove il
   campo è basso. Il dato è forte ma su un solo punto.
6. **Applicare.** Risponde alla proposizione sulla tolleranza termica con confidenza media. Riserva il Data
   Assist per una proposizione sulla predazione, che il dato attuale non copre.

**Cosa ha fatto bene:** ha scelto il test più economico che separava due ipotesi.
**Cosa ha sbagliato (possibile):** ha misurato troppo presto o troppo tardi. Il secondo tentativo può
correggerlo.

---

## 9. Verifiche con i giocatori

Le verifiche usano lo stesso schema di GDD §14. Qui sono specifiche al loop.

| ID | Ipotesi | Come | Conferma | Smentita |
|---|---|---|---|---|
| **H-loop-1** | Il loop è chiaro in 10 secondi | Mostrare la schermata iniziale a 5 persone senza spiegazioni, chiedere cosa possono fare | 4 su 5 dicono “scelgo uno strumento e clicco” | Non capiscono che la Carica si spende |
| **H-loop-2** | Il taccuino riduce i tentativi a vuoto | Due gruppi, con e senza taccuino, su FER-1 | Il gruppo con taccuino fa meno esperimenti per risposta | Nessuna differenza |
| **H-loop-3** | Esistono almeno due strumenti usati per ogni tipo di domanda | Registrare gli strumenti usati per settore | Più di un tipo di strumento usato per settore | Uno strumento domina |
| **H-loop-4** | La Carica genera scelte, non solo spreco | Chiedere ai giocatori cosa hanno scelto di *non* fare | Citano almeno un'alternativa scartata | Non ricordano scelte |
| **H-loop-5** | Il tempo di attesa dopo un impulso è accettabile | Misurare il tempo tra impulso e risposta usata | Attesa ≤ 2 min reali | Abbandoni durante l'attesa |
| **H-loop-6** | Il ritentativo è un desiderio, non un obbligo | Dopo il primo settore, chi ha F o C riprova? | Almeno un terzo riprova | Nessuno riprova |
| **H-loop-7** | Il seed fisso non rovina la seconda partita | Confrontare tempi e precisione del secondo tentativo | Secondo tentativo più preciso, non solo più rapido | Secondo tentativo solo più rapido |

---

## 10. Decisioni richieste

| # | Decisione | Motivo | Dipendenza |
|---|---|---|---|
| L1 | Il taccuino di ipotesi entra nel MVP? | Rende visibile la fase 2 | §3 |
| L2 | Il peso dell'efficienza resta a 0.15? | Oggi la Carica è poco punitiva | §4.3, §6.1 |
| L3 | L'Integrità entra nel punteggio o resta solo un limite? | Oggi non ha peso strategico | §6.3 |
| L4 | I ritentativi usano il seed fisso o variabile? | Cambia il motivo per riprovare | §7.2 |
| L5 | Correggere il controllo di disponibilità ora? | È un bug, con effetto già osservabile | §6.2 |
| L6 | Esiste un limite di probe? | Cambia il costo della fase 4 | §6.4 |

**Ordine consigliato:** prima verificare i fatti marcati [DA VERIFICARE] (L5, L6), poi decidere L2 e L3 con un
bilanciamento misurato (`npm run balance`), poi playtest per H-loop-1…7.
