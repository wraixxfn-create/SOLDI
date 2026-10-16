# WORLDBUG — Design Document (v1.0)

> Every mechanic described here is implemented in the shipping build. This document is the
> authoritative reference for the game's rules; `docs/ARCHITECTURE.md` covers how they are coded
> and `docs/REGISTRY.md` tracks implementation status, tests and open issues.

## 1. High concept

**WORLDBUG** is a single-player HTML5 game of *field science* set on alien biospheres whose rules
are unknown to the player. You are a Xenological Analyst of the *ISV Meridian* survey. You cannot
command the ecosystem: you can only **observe** it, **disturb** it with a strictly limited energy
budget, **deduce** the laws that govern it, and **file a Codex report** before the survey window
closes — without destroying the biosphere you are studying.

Three pillars, in tension with each other:

| Pillar | Player fantasy | System |
| --- | --- | --- |
| **Simulation** | "This world is really alive" | A deterministic agent + scalar-field ecosystem running hundreds of organisms with metabolism, tolerance, diet, reproduction and death. |
| **Deduction** | "I figured the world out" | Hidden per-species law parameters must be inferred from observed behaviour and experiments, then committed to a graded report. |
| **Strategy** | "I spent my budget wisely" | Charge is finite, disturbance costs Integrity, destructive experiments damage the ecosystem you are scored on preserving. |

## 2. Core loop

```
  ┌────────────┐   probes / scan    ┌────────────┐
  │  OBSERVE   │───────────────────▶│  EVIDENCE  │
  │ run sim    │                    │ auto log   │
  └────┬───────┘                    └─────┬──────┘
       │ instruments (Charge)            │
       ▼                                 ▼
  ┌────────────┐   analyse (Charge) ┌────────────┐
  │ EXPERIMENT │───────────────────▶│  HYPOTHESIS│
  └────┬───────┘                    └─────┬──────┘
       │ Integrity cost                  │ commit
       ▼                                 ▼
  ┌────────────┐                    ┌────────────┐
  │  BIOSPHERE │─── stability ─────▶│   REPORT   │──▶ rank S/A/B/C
  └────────────┘      score         └────────────┘
```

## 3. The simulation

### 3.1 Territory, climate and resources

* A world owns a finite, closed `W × H` rectangle of square grid cells (`W: 16–128`, `H: 12–128`).
  Organisms reflect at its edge; terrain sources, pulses, barriers, resource grids and biomass share
  these coordinates. The dimensions and every initial value are explicit in `SectorConfig`.
* Three climate fields describe conditions, not consumable stocks:
  * **Temperature** in kelvin, clamped to **150–450 K**;
  * **Humidity** as normalized saturation, **0–1**;
  * **Light** as normalized irradiance, **0–1**.
* Two spatial resources are separately modeled and have their own unit limits:
  * **Available water**: normalized stock **0–1 per cell**, recharged toward local humidity, evaporated
    and diffused every turn;
  * **Mineral nutrients**: abstract stock **0–4 units per cell**, regenerated at the configured rate,
    diffused, consumed by photosynthetic species and returned by decomposers.
* Standing organic biomass is **0–4 abstract biomass units per cell per species**. Producers deposit
  biomass; consumers remove it; decomposers mineralize consumed organic stock. It is distinct from
  the water and mineral resource grids.
* Terrain sources (thermal, cryogenic, mist/arid, lumen/shade) alter climate with radial falloff.
  Fields diffuse and relax toward their baseline. Their definitions, pulses, resource rates and rule
  documents are validated before `World` construction.

### 3.2 Species and turn lifecycle

Species data is parameterized rather than implemented by duplicating species-specific update logic.
Each definition supplies its trophic role and strategy, diet, tolerance, water/nutrient demand, energy
budget, reproduction threshold/cost/cooldown/maturity/lifespan, stress response, speed, wandering,
sensory radius and optional typed mutualism/mineralization values. Four starter strategies are
provided: photosynthetic (`PHY-1`), predatory (`PRE-1`), decomposer (`DEC-1`) and symbiotic (`SYM-1`).
The 12 authored campaign species continue to use the same shared engine.

One discrete turn follows this exact causal order (`WORLD_TICK_PHASES`):

1. **Environment** — advance the tick, scheduled pulses, terrain persistence/diffusion/relaxation and
   configured environment rules.
2. **Resource availability** — recharge, evaporate and diffuse water; regenerate/diffuse nutrients;
   decay and spread standing biomass.
3. **Metabolism** — sample climate, update stress/age/cooldown and pay the baseline metabolic and
   exposure costs.
4. **Interactions** — photosynthesis constrained by local water/nutrients; biomass feeding and
   predation; decomposition/mineralization; pairwise symbiosis. Movement decisions are planned from
   the same positions and committed after all plans are chosen.
5. **Reproduction** — eligible parents pay their configured cost and reserve population-cap slots;
   newborn records are queued and are not updated in the turn they are born.
6. **Mortality** — resolve interaction-caused deaths, starvation, age and sustained exposure.
7. **State update** — compact dead agents, commit the queued newborns, update extinctions, events,
   probes and population history.

Within interacting organisms, the simulation uses stable ascending agent ids; rule ties use stable
rule ids. Food and local capacity are therefore arbitrated intentionally, never by incidental array
insertion order. New positions are committed as a separate movement pass, preventing a predator's
sensing result from changing because its prey happened to be iterated first.

### 3.3 Determinism and rendering boundary

The world is a pure replay of `(validated config, explicit seed, ordered actions)`. Mulberry32 is the
only pseudorandom generator. Initial placement uses per-species streams; hunts, movement and births
use streams derived from agent id, tick and generation, so one subsystem or an unrelated organism
cannot shift another's random sequence. Simulation code never reads wall-clock time or `Math.random`.
The renderer is read-only: drawing or changing overlays cannot affect world state or random streams.

### 3.4 Declarative rule engine

World rules are JSON-safe data with a stable id, integer priority, `stack` or grouped `exclusive`
mode, `each-turn` or `once` frequency, a prerequisite expression and one or more typed effects.
Prerequisites are a closed AST (`all`, `any`, `not`, field/resource means, population, population
ratio, biomass and tick comparisons). Effects are a closed set of field/resource shifts and
species-scoped metabolism/growth/reproduction multipliers. A bounded parser rejects unknown keys,
operations, species, coordinates, values, excessive nesting and non-plain objects. Rules are sorted
by priority then id and evaluated from one immutable turn observation; no `eval`, callbacks, script
strings or arbitrary level code are accepted.

## 4. Player capabilities

### 4.1 Survey tools (free, always available)

| Tool | Effect |
| --- | --- |
| **Field overlay** | Toggle temperature / humidity / light / biomass overlays; the temperature overlay is what makes "thermal niche" deduction possible. |
| **Organism scanner** | Click (or keyboard-cursor) any organism to open the Inspector: species, age, energy, current field readings at its position, its recent events. |
| **Probes** | Place up to `N` autonomous sensors; they sample the fields *and* count organisms of each species in a radius over time. Probe recordings are charted in the Data panel. |
| **Event log** | Chronological, filterable, per-species log of births, deaths (with cause), kills, grazing spikes and field pulses. |

### 4.2 Instruments (cost Charge; some cost Integrity)

| Instrument | Charge | Integrity | Effect |
| --- | --- | --- | --- |
| Thermal Pulse | 2 | 0 | +Δ temperature in a radius, decaying |
| Cryo Pulse | 2 | 0 | −Δ temperature |
| Humidifier | 2 | 0 | +Δ humidity |
| Desiccator | 2 | 0 | −Δ humidity |
| Illuminator | 2 | 0 | +Δ light |
| Umbra Field | 2 | 0 | −Δ light |
| Nutrient Bloom | 3 | 0 | Instant biomass injection for producers |
| Containment Barrier | 3 | 1 | Blocks movement across a line (repeatable, removable) |
| Cull Wave | 4 | 6 | Removes organisms in a radius (destructive) |
| Hatchery | 5 | 2 | Introduces individuals of a chosen species |

Disturbance decays back toward the baseline environment, so a pulse is a *measurement*, not a
permanent edit: the world answers the question and then heals.

### 4.3 Analysis (cost Charge)

For each open proposition the player may spend Charge on a **Data Assist**: the game runs the actual
statistics over everything recorded so far (probe samples + event log) and shows a real, derived
figure — e.g. *"Observed mean temperature at capture sites of AURELIA: 344 K (n=118); mean at
death-by-exposure sites: 233 K (n=37)."* Assists never contain the answer; they contain the data the
player could have collected manually, which keeps deduction in the player's hands while making the
puzzle solvable without note-taking tedium.

## 5. The deduction layer

Each sector declares a set of **law propositions** generated directly from the hidden simulation
parameters at sector-construction time:

* **Tolerance band** — "Species X thrives in *cold / temperate / hot* (resp. dry / balanced / wet,
  dark / dim / bright) conditions." The correct band is derived from the species' actual ideal value;
  distractors are the other bands.
* **Trophic link** — "Which species does X feed on?" Options: the real diet species, common decoys,
  and "X is a primary producer".
* **Vulnerability** — "Which species is X most dependent on?" (derived from the diet/predation graph).
* **Reproduction driver** — "X reproduces fastest when *light / moisture / warmth* is abundant."
  Derived by actually measuring, at sector-build time, which environment term gates its reproduction.
* **Stress response** — "When exposed to conditions it cannot tolerate, X *dies / migrates /
  stops reproducing*." Derived from the species' behavioural parameters.

Because propositions *are* the parameters, grading cannot lie, and every proposition is in principle
observable in-game (that is the fairness invariant asserted by the test suite).

A proposition is answered by picking one option (or "unknown"), and locked in with a confidence
marker. The report is filed when all propositions are answered or the survey window (tick limit)
expires; unanswered propositions score as incorrect.

## 6. Mission scoring

```
correctness  = weighted correct propositions / total        (0..1)
conservation = f(final biomass vs. target band, extinctions) (0..1)
efficiency   = 1 − spentCharge / initialCharge × 0.5         (0.5..1)
score        = 1000 × correctness^1.3 × (0.6 + 0.25·conservation + 0.15·efficiency)
rank         = S ≥ 900 · A ≥ 750 · B ≥ 550 · C otherwise
```

An ecosystem collapse (all species extinct) fails the sector regardless of the report: the survey
rejects a report filed over a dead world. Ranks gate progression: sector *n+1* unlocks after sector
*n* is filed with rank **C or better**.

## 7. Sectors (campaign)

| # | Name | Species | New mechanic |
| --- | --- | --- | --- |
| 1 | FER-1 «Cinder Shelf» | 2 (1 producer, 1 grazer) | Tutorial: reading fields, one tolerance law |
| 2 | KEL-4 «Vault Basin» | 3 (+1 predator) | Trophic links, kill evidence |
| 3 | VOX-9 «Lumen Reef» | 4 (+1 shade-dwelling filter) | Light as a niche axis, grazing pressure |
| 4 | ORP-2 «Ashfall» | 4 | Pulsing environment: a periodic heat surge changes what "thriving" means; migration laws |
| 5 | TAU-7 «Ghost Meridian» | 5 | Invasive species scenario: the player must diagnose a collapsing world |

Each sector also defines: grid size, baseline fields, terrain sources, initial populations, starting
Charge, survey window (ticks), conservation target (final biomass band) and the instrument set.

## 8. UX / accessibility

* **Layout** — three-pane desktop layout (left: instruments + mission; centre: world canvas; right:
  inspector / data / codex). Collapses to a stacked, tabbed layout on phones.
* **Input** — 100 % playable with mouse, touch and keyboard. Canvas cursor movement with arrow keys,
  `Enter` to act, `1`–`9` to select instruments, `Space` to pause, `,`/`.` to change speed, `?` for help.
* **Screen readers** — every readout in the Inspector/Data/Codex panels is real DOM text, updated
  through `aria-live` regions with conservative politeness. The canvas has an accessible text
  summary (population table + field extrema + cursor cell readings) so the game is playable without
  seeing the map.
* **Options** — reduced motion, high-contrast HUD, three colour-vision-safe palettes, UI scale,
  sound volume/mute (all audio is synthesised at runtime; no asset downloads), auto-pause on tab
  blur, and a "confirm destructive tools" toggle.
* **Performance** — simulation and rendering are decoupled; the renderer draws only visible layers,
  reuses offscreen buffers and skips effects under reduced motion. Target: 60 fps at 48×32 with 600
  organisms on a 2019-class laptop, degraded gracefully (adaptive quality) if frames run long.

## 9. Non-goals (v1.0)

* No backend, accounts, analytics, ads, monetisation, or AI services. The game is a static bundle.
* No multiplayer. No procedural campaign generation (sectors are authored, deterministic content).
* No external art/audio assets: all visuals are drawn with canvas primitives and all sound is
  synthesised with the Web Audio API, so the build has zero binary assets and zero licensing surface.
