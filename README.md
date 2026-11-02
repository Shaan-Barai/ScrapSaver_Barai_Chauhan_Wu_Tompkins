# ScrapSaver: measuring and forecasting dining hall food waste

A research prototype from MHacks by **Barai, Chauhan, Wu and Tompkins**, built around the University of Michigan's dining halls (M-Dining). It measures the food left on returned plates from photos, and tests whether better prep forecasts could cut that waste.

**Status:** detection runs on real plate photos (numbers below). The weight estimate has been tested on a public dataset of full plates. Every forecasting result so far is **simulated**; the real-data pilot is next.

## The problem

A dining hall decides before each meal how much of each dish to prepare:
- prepare too little, and the dish runs out mid-meal;
- prepare too much, and the extra is thrown away, wasting its cost and its environmental footprint.

The hall plans with the forecast in its food-service software (FSS). What diners take and then leave on their plates isn't recorded per dish. Without that record, there's no number to plan against and no way to tell whether a change in prep reduced waste.

## Approach

**1. Measure plate waste from photos.**

```text
plate photo → Gemini (which menu foods, and where) → SAM 2.1 (a mask per food) → pixels counted in code
            → grams (camera calibration × each food's grams per cm²) → estimated kg CO2e and litres of water
```

- **Menu-first classification:** Gemini only chooses among that meal's menu items, and marks the plate being scanned so food on neighbouring plates isn't counted.
- **Masks and pixels:** SAM 2.1 (`sam2.1-hiera-small`) draws a mask from each Gemini box. **Pixels wasted** is counted from the validated masks, in code. It is the stored measurement.
- **Labeled estimates:** grams, CO2e and water are always labeled estimates, derived from pixels at read time. They are empty (never zero) when no calibration exists.

**2. Forecast how much to prepare.** For each dish and meal:

```text
prepped = eaten + tray waste + pan leftover
```

- **Inputs:**
  - Prepped and pan leftover come from the kitchen's production sheets, read by an AI model and confirmed by a person.
  - Tray waste comes from the plate photos.
- **Forecast and prep amount:** models forecast demand, treating meals that ran out as "at least this much". A newsvendor rule then sets the prep amount from the cost of running out vs. the cost of waste, where the waste cost includes an environmental price.
- **Shadow mode:** for a pilot, the hall keeps cooking from FSS exactly as today. ScrapSaver writes and locks its forecast before each meal, and is scored against FSS and the actual numbers afterwards.

Methods: [docs/forecasting-methods.md](docs/forecasting-methods.md). Pilot plan: [docs/pilot-runbook.md](docs/pilot-runbook.md).

## Results so far

Each number below is copied from the linked page, which says exactly what was measured.

### Detection: which menu foods are on the plate [REAL photos]

- **Recall 94.4%, precision 94.4%:** 17 correct, 1 missed, 1 wrong.
  - Measured 2026-10-29 on **12 real plate photos with 18 hand-labeled foods**, all from **one dinner at one dining hall**.
  - Scored against that dinner's 23-food menu. `gemini-3.8-flash`, fixed seed, temperature 0.
- **Against a 26-food menu** (3 extra foods): recall 94.4%, precision 81.0%, identical in 3 repeated runs.
- **The miss was a timeout,** since fixed. The fix's expected effect (no misses) is a **projection, not yet measured.**
- **Not scored:** mask quality (pixel areas vs. hand-drawn masks).

Details: [docs/detection-accuracy.md](docs/detection-accuracy.md).

### Time per plate [REAL photos]

- **Average 34.7 s, median 38.4 s per plate** (range 14.9–50.0 s), on 11 of the same 12 photos.
- The 12th timed out (3 × 90 s); that is the timeout the fix above addresses.
- Almost all of the time is the two Gemini passes, which run at the same time. SAM takes about 0.5 s.

Details: [docs/detection-accuracy.md → Timing](docs/detection-accuracy.md#timing-and-the-pass-2-timeout-run-5-2026-10-29).

### Weight: grams from area [Nutrition5k full plates, not leftovers]

Tested on 31 public Nutrition5k plates, each weighed on a scale. The factors were fitted on 27 other plates:

| Grams estimated from | Mean absolute error | Mean absolute % error |
|---|---|---|
| area × our current per-food factors | 35.8 g | 45% |
| area × factors measured on Nutrition5k | 20.4 g | 33% |
| depth (volume) × measured density | 24.7 g | 38% |

- **Masks:** this test used stand-in masks (colour + depth boxes → SAM), because the Gemini API was unavailable at the time.
- **Foods:** single-food plates of 7 food types, 2–5 test plates per food.
- **What it shows:** our current factors are the weak point. Per food they were off by −56% to +53%, and +161% on the two greens plates. Depth didn't beat area overall.

Details and limits: [docs/weight-accuracy.md](docs/weight-accuracy.md).

### Forecasting [SIMULATED]

**All forecasting results so far are simulated:** a made-up hall over 6 weeks, 15 dishes, 291 dish-meals.
- Five models land at 18.3–22.3% WAPE.
- These numbers show that the pipeline runs end to end. **They are not evidence about any real dining hall or about FSS.**
- **Next:** a 6-week shadow pilot on M-Dining's real swipe counts, FSS export and production sheets.

Details: [docs/forecasting-methods.md §8](docs/forecasting-methods.md#8-results-so-far).

## Limitations and what's next

- **Small, single-meal detection test.** 12 photos from one dinner. Masks are not yet scored against hand-drawn masks.
- **Weight is checked on full lab plates, not leftovers,** and not with our camera. Our hall camera hasn't been calibrated yet. The per-food factors need replacing with measured ones.
- **No real forecasting data yet.** The comparison "FSS" is a simulated stand-in until a real export is imported.
- **Next:**
  1. Measure the timeout fix end to end.
  2. Score the masks.
  3. Re-run the weight test with the real Gemini → SAM pipeline.
  4. Calibrate the hall camera.
  5. Run the shadow pilot.

## Credits

- **Team:** Barai, Chauhan, Wu, Tompkins.
- **Nutrition5k:** Thames et al., CVPR 2021, Google Research. [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). Source: https://github.com/google-research-datasets/Nutrition5k.
- **SAM 2.1** (Segment Anything Model 2), Meta AI. Code and checkpoints under Apache 2.0. Source: https://github.com/facebookresearch/sam2.
- **Gemini API**, Google. Used under the [Google APIs Terms of Service and the Gemini API Additional Terms](https://ai.google.dev/gemini-api/terms).
- **Open-Meteo** weather data, [CC BY 4.0](https://open-meteo.com/en/terms) (forecast context features).

---

## For developers

The sections below describe the running system: the dashboard, the demo and setup.

**What the dashboard shows:**
- **Pixels wasted:** foreground pixels in validated masks of visible leftover food. This is the primary measurement.
- **Waste per portion:** pixels ÷ portions served, used to rank foods to target.
- **Relative impact points:** `pixels/1000 × weight_g_per_cm2 × (0.19·C + 1.50·W)` ([factors/README.md](factors/README.md)). They are unitless, compare foods only with each other, and are not kg, litres or dollars.
- **Labels:** attendance and portion counts in the demo are labeled **simulated** / **demo**.
- **Portions served:** enter real per-food counts in the dashboard or upload a CSV ([the portion-count guide](docs/portions-served.md)).
- **Data path:** camera → laptop inbox → bridge (one capture per dish) → Supabase Storage + Postgres → Gemini + SAM 2.1 → counted pixels and an overlay image → dashboard ([BRIDGE.md](docs/BRIDGE.md)).

## Calibrated area, CO2e and water (IT_4)

With an active **camera calibration**, each food also gets an **estimated**
area (cm²) and grams, plus kg CO2e and litres of water. These are shown next to
the food's label on the plate image and on the dashboard.

1. Lay a credit card (46.21 cm²) or any flat object of measured area where the
   plates go, with the camera locked in place.
2. Run `npm run calibrate -- --known-area-cm2 46.21` in `capture/`, or use
   Settings → Camera calibration.
3. Grams = area × the food's `weight_g_per_cm2`; kg CO2e and litres of water
   follow from grams. See [docs/calibration.md](docs/calibration.md) and
   [IT_4.md](docs/plans/IT_4.md).

Pixels wasted stays the primary measurement. Without a calibration, the
physical numbers are blank, never zero.

**Run the whole stack locally in production mode:**
`deploy/local.sh up | status | smoke | down` ([docs/deploy.md](docs/deploy.md)).
**Public site without the Mac:** scrapsaver.app runs **read-only** on an offsite Linux server
(`READ_ONLY=1`: recorded data only, no uploads, edits, Gemini or SAM):
`deploy/server/deploy.sh setup | sync-db | push | tunnel | status` ([docs/deploy-server.md](docs/deploy-server.md)).

## Demo

One command runs and narrates the whole product: the Uno Q takes a photo, sends it to the laptop,
the bridge puts it in R2 and SpacetimeDB, Gemini + SAM 2.1 segment it, and the demo prints the
pixels, where every object is stored, total waste, waste per portion, most wasted, relative impact,
the AI recommendation, saves a "photo | AI segmentation" picture per plate, and opens the dashboard.

```bash
python3 demo.py                  # real camera (arduino@35.1.88.76), press Enter per plate
python3 demo.py --simulate       # no board: test2/ photos through the same path (labeled replay)
python3 demo.py --plates 3 --yes # three plates, no pauses
python3 demo.py --list           # the steps; --only/--skip pick some, --events cap_… re-shows captures
python3 demo.py --simulate --hall hall-test   # run on a test hall instead of hall-main
```

**Upload website:** `node upload_demo/server.mjs` → http://localhost:8795. One "Upload a photo"
button; after the upload, a results page shows the original, Gemini's classification, SAM 2.1's masks,
the final result and the total food wasted (matched against every food in the food database;
[`upload_demo/README.md`](upload_demo/README.md)).
[`demo_pictures/`](demo_pictures/README.md) shows every step for the halal chicken + rice bowl.

It needs the stack from [Setup](#setup) (it offers to start missing services) and writes its
photos and logs to `images/demo-runs/` (gitignored). **Adding a feature? Add a demo step**
(AGENTS.md §3 rule 13).

## Documents

- [`IT_4.md`](docs/plans/IT_4.md) — calibrated area, estimated CO2e/water, local production stack (plan + tracker; Depth Anything V2 was tried and removed).
- [`docs/deploy-server.md`](docs/deploy-server.md) — **read-only public site on an offsite server** (the Mac can be off); `sync-db` copies new data up.
- [`docs/deploy.md`](docs/deploy.md) — **deploy the website**: local production stack (`deploy/local.sh`) + Cloudflare Tunnel + custom domain, step by step.
- [`BIG-PLAN.md`](docs/plans/BIG-PLAN.md) — the camera → impact → dashboard plan and its tracker.
- [`EXPLAIN.md`](docs/EXPLAIN.md) — the whole database (SpacetimeDB + R2) in plain language.
- [`factors/README.md`](factors/README.md) — the waste
  impact formula and per-food factors (nutrition in `factors/menu_nutrition_factors_EastQuad.csv`).
- [`AGENTS.md`](AGENTS.md) — the working plan: agent roles, ownership, rules,
  measurement formulas, and completion checks.
- [`UI.md`](docs/plans/UI.md) — dashboard spec (layout, palette, copy).
- [`MVP_AI.md`](docs/plans/MVP_AI.md) — researched Meta SAM segmentation plan and
  bounding-box model options; implementation and food-image evaluation are pending.
- [`AI.md`](docs/plans/AI.md) — current AI flow. The DepthAnythingV2 volume idea was
  tried in IT_4 and removed (see `contracts/decisions.md`).
- [`contracts/`](contracts/) — shared entity types, error format, sample
  records, and [recorded decisions](contracts/decisions.md).

## Repository layout

| Directory | Owner | Contents |
| --- | --- | --- |
| `contracts/` | Agent 1 | Shared types, samples, decisions |
| `data/`, `db/` | Agent 2 | Menu parsing/validation, SpacetimeDB schema, seeds |
| `capture/` | Agent 3 | Camera/replay capture adapter |
| `vision/` | Agent 4 | Gemini classification, segmentation, mask pixel counting |
| `backend/` | Agent 5 | API, object-storage adapter, orchestration |
| `analytics/` | Agent 6 | Aggregates, simulated attendance, suggestions |
| `frontend/` | Agent 7 | ScrapSaver dashboard (React + Tailwind) |
| `docs/`, `tests/` | Agent 8 | Demo docs, fixtures, integration/e2e tests |
| `supabase/` | Agent 1 | Postgres schema, RLS and Storage bucket as Supabase CLI migrations (`supabase/migrations/`) |
| `forecast/` | — | Forecast worker, evaluation, prep sheets and the simulated test dataset (Python, stdlib) |
| `factors/` | Agents 2+6 | Per-food waste/nutrition factor CSVs (East Quad, Halal Bros, 500 common foods), menu labels, and the formula README; `data/` generates its tables from them |
| `docs/plans/` | Agent 1 | Planning/spec docs and trackers (BIG-PLAN, IT_4, DEBUG-PLAN, UI, AI, MVP_AI) |
| `deploy/` | — | Local production stack, smoke test, Cloudflare Tunnel; `deploy/server/` for the read-only offsite server |
| `experiments/` | — | One-off segmentation/menu experiment outputs and `test_sam.py` (not used at runtime) |
| `test2/`, `demo_pictures/`, `upload_demo/` | — | Demo plate photos, pipeline pictures, upload demo site (used by `demo.py`) |
| `archive/preview-app/` | — | Earlier standalone preview app, superseded by `frontend/` + `backend/` (not used at runtime) |

Root files: `demo.py` (one-command demo) and `test-all.sh` (every test).
`images/` holds local, gitignored photos and demo-run logs.

## Setup (Supabase: Postgres + Storage + Realtime)

Records live in **Supabase Postgres**, images in a private **Supabase Storage** bucket, and the
dashboard refreshes itself through **Supabase Realtime**. The plan, mapping and security model are in
[docs/supabase-migration-plan.md](docs/supabase-migration-plan.md).

Environment (`.env` at the repo root; gitignored, never commit it; see `.env.example`):

| Variable | Used by | Notes |
| --- | --- | --- |
| `SUPABASE_URL` | backend, workers, dashboard build | The **API address** `https://<project-ref>.supabase.co` (Project Settings → API), not a dashboard link |
| `SUPABASE_ANON_KEY` | dashboard build | Publishable key; RLS lets it read dashboard tables only |
| `SUPABASE_SERVICE_ROLE_KEY` | backend, workers, scripts | Secret key, **server only**. The dashboard build refuses it |
| `SUPABASE_DB_URL` | migrations, one-time import | Session pooler connection string |
| `DATABASE_PROVIDER=supabase` | backend | Use Postgres (otherwise SpacetimeDB/in-memory) |
| `OBJECT_STORAGE_PROVIDER=supabase`, `OBJECT_STORAGE_CONTAINER=scrap-images` | backend | Private bucket; signed upload and read URLs |
| `GEMINI_API_KEY` | backend | Live classification and production-sheet reading |

```bash
set -a; . ./.env; set +a      # load the variables into this shell (the backend and workers read the environment)

# 1. Schema, RLS, functions and the private bucket (idempotent; review with --dry-run first)
npx supabase db push --db-url "$SUPABASE_DB_URL" --dry-run
npx supabase db push --db-url "$SUPABASE_DB_URL"

# 2. SAM 2.1 worker (see vision/sam/README.md) and the backend (http://localhost:8787)
.venv/bin/python vision/sam/worker.py
cd backend && npm ci && DATABASE_PROVIDER=supabase OBJECT_STORAGE_PROVIDER=supabase npm start

# 3. Dashboard (http://localhost:5173); reads SUPABASE_URL + SUPABASE_ANON_KEY for live refresh
cd frontend && npm ci && npm run dev

# One-time import of old SpacetimeDB data + local-dev images (re-runnable; prints old vs. new counts)
cd backend && SPACETIMEDB_URI=http://127.0.0.1:3901 node scripts/import-spacetime-to-supabase.mjs --dry-run
```

### Forecasting

Production sheets (dashboard → **Production sheets**) are read by Gemini into *unconfirmed* rows; a
person checks and confirms each one. The forecast worker turns confirmed history, swipes and the menu
cycle into prep amounts; **Forecast** compares them with what happened and with the FSS forecast.
Details: [forecast/README.md](forecast/README.md).

```bash
python3 -m forecast.worker run --hall hall-main --start 2026-10-25 --end 2026-10-31   # write forecasts
python3 -m forecast.worker serve                                                     # or as a service (:8791)
python3 -m forecast.evaluate --hall hall-main --start 2026-09-26 --end 2026-10-23     # score past forecasts
python3 -m forecast.prep_sheet --hall hall-main --date 2026-10-25                      # printable sheets -> forecast/out/
```

**Simulated data.** Until real production sheets exist, `python3 -m forecast.simulate generate --hall
hall-main` writes one made-up dataset (every row `is_simulated = true`; the dashboard and prep sheets
show a SIMULATED banner). **Remove it with one command:** `python3 -m forecast.simulate remove --hall
hall-main` (deletes only `is_simulated` rows).

## Legacy setup (SpacetimeDB + R2; kept until their removal is approved)

Prerequisites: Node.js 20.12+ and the SpacetimeDB CLI 2.10.x
(`curl -sSf https://install.spacetimedb.com | sh`).

```bash
# 1. Secrets (server-side only; .env is gitignored — never commit it)
cp .env.example .env            # then set GEMINI_API_KEY and the R2_* bucket credentials

# 2. Local SpacetimeDB (keep running in its own terminal)
spacetime start

# 3. One-time: a local identity that owns the database, saved to .env
echo "SPACETIMEDB_TOKEN=$(curl -s -X POST http://127.0.0.1:3000/v1/identity | node -pe 'JSON.parse(require("fs").readFileSync(0)).token')" >> .env
spacetime login --token "$(grep ^SPACETIMEDB_TOKEN= .env | cut -d= -f2)"
cd db/spacetimedb && npm ci && spacetime publish --module-path . --server local --yes scrap && cd ../..
#    (additive schema changes publish in place; never use --delete-data on scrap)

# 4. SAM 2.1 segmentation worker (Python venv with Meta's sam2; see vision/sam/README.md)
.venv/bin/python vision/sam/worker.py      # own terminal; http://127.0.0.1:8790

# 5. Backend API (builds data/vision/analytics first) — http://localhost:8787
cd backend && npm ci && SPACETIMEDB_MODULE=scrap npm start   # own terminal

# 6. Demo data: seed menus (incl. the 26-food dinner) + demo portions served
cd backend && SPACETIMEDB_MODULE=scrap npm run seed -- --live-dinner   # adds today's 26-food dinner

# 7a. Real camera: Uno Q → laptop inbox, then the bridge (docs/BRIDGE.md, docs/ARDUINO.md)
python3 capture/uno-q/laptop_capture.py --target arduino@YOUR_BOARD_IP --auto
cd capture && npm ci && npm run ingest-inbox -- --service svc_hall-main_2026-10-03_dinner --watch
# 7b. No board: simulate the camera with the test2/ photos (one dish per photo)
cd capture && npm run simulate-camera -- --service svc_hall-main_2026-10-03_dinner

# 8. Dashboard — http://localhost:5173 (proxies /api to the backend)
cd frontend && npm ci && npm run dev
```

Images are stored in a private **Cloudflare R2** bucket: create the bucket and
an R2 API token with Object Read & Write on it, then fill in
`OBJECT_STORAGE_CONTAINER` and `R2_ACCOUNT_ID` / `R2_ACCESS_KEY_ID` /
`R2_SECRET_ACCESS_KEY`. Set `OBJECT_STORAGE_PROVIDER=local-dev` to run without
a Cloudflare account (files under `backend/.local-storage/`).

Always pass `--server local` to `spacetime` commands: the CLI's default
server is the hosted maincloud. Without `GEMINI_API_KEY` the backend uses a
deterministic mock analyzer; without `SPACETIMEDB_URI` it uses an in-memory
store. `VITE_USE_MOCK=1 npm run dev` runs the dashboard on demo data alone.

## Verify

**One command runs everything** (see [docs/runbook.md](docs/runbook.md)):

```bash
./test-all.sh            # offline: every package, dashboard build, db typecheck, integration, Python, scripts
./test-all.sh --live     # + starts the local stack: smoke test, live E2E suites, demo.py --simulate (test halls only)
./test-all.sh --list     # suites; --only a,b / --skip a,b / --install / --fail-fast
```

Supabase checks (live project; each cleans up after itself; need the `SUPABASE_*` variables):

```bash
cd tests && node --env-file=../.env --test system/supabase-storage.test.mjs system/supabase-rls.test.mjs \
  system/supabase-realtime.test.mjs system/supabase-pipeline.test.mjs system/supabase-production.test.mjs
cd backend && npm run build && SCRAP_LIVE_REPO_TEST=1 node --env-file=../.env --test dist/backend/test/supabaseRepository.live.test.js
cd tests && LIVE_STACK=supabase GEMINI_CAP=60 npm run test:images     # LIVE: all test2/ photos on Supabase (~32 Gemini calls)
python3 -m unittest discover -s forecast/tests -t .                  # forecast formulas (no database)
```

Or one command per test level (details: [docs/testing.md](docs/testing.md)):

```bash
cd tests && npm run test:unit          # every package's unit tests, offline
cd tests && npm run test:integration   # test2/ through the real ingest path, R2 test/ round trip, SpacetimeDB on a throwaway db, mocked SSH
cd tests && npm run test:images        # LIVE: all test2/ photos through Gemini + SAM + R2 + SpacetimeDB + dashboard API
cd tests && npm run test:camera -- auto   # real Uno Q: stages 1-6 (then: plate, empty, reliability, cleanup)
cd tests && npm run test:smoke         # dashboard in Chrome (Playwright)
```

Camera and the dashboard button: `cd capture && npm run take-photo` (settings in `.env`: CAMERA_HOST, CAMERA_USER, CAMERA_SSH_KEY).
Sample history: `cd backend && npm run demo:seed` (DEMO_SEED=1) / `npm run demo:clear`.

Individual suites:

```bash
cd tests && npm test                          # fixture + formula checks
(cd <module> && npm test)                     # data capture vision analytics backend frontend
cd vision && npm run smoke                    # live Gemini smoke test (uses .env key)
cd tests && SCRAP_E2E=1 npm run test:e2e      # live API flow against the running stack
cd tests && SCRAP_E2E=1 npm run test:e2e:scrap   # camera sim → R2 → scrap → Gemini+SAM → dashboard API
python3 capture/scripts/live_camera_test.py --target arduino@<board-ip> --identity ~/.ssh/scrap_unoq --service svc_hall-main_<date>_dinner --spacetime-db scrap   # real Uno Q
```

### API additions (BIG-PLAN)

`start`/`end` are inclusive local service dates (`YYYY-MM-DD`); pass `hallId`.

| Endpoint | Returns |
| --- | --- |
| `GET /api/dashboard/impact?start&end&hallId` | totals (pixels, relative impact points; nutrition points separate), foods to target (pixels per portion), most wasted (pixels), coverage incl. neighbor-food exclusions |
| `GET /api/captures?start&end&hallId[&limit]` | recent plates with state and pixels per food |
| `GET /api/captures/:eventId/images` | short-lived URLs for the original photo, segmented overlay, and per-food masks |
| `GET /api/recommendation?start&end&hallId` | AI recommendation (`gemini`) or labeled rule-based `fallback`, with cited metrics |
| `GET /api/dashboard/daily` | per-day Pixels wasted |
| `GET /api/dashboard/totals?today&hallId` | Pixels wasted today, this week (Mon-today), this month (1st-today) |
| `POST /api/recommendation/regenerate` | asks Gemini again for `{start,end,hallId}`; every recommendation is saved (insight table) with its inputs |
| `GET /api/camera/status`, `POST /api/camera/take-photo` | `npm run take-photo` (the dashboard has no camera button) |
| `POST /api/demo/seed`, `POST /api/demo/clear` | labeled sample history (DEMO_SEED=1) and removing it |

See [`docs/`](docs/) for the [demo walkthrough](docs/demo-walkthrough.md),
[runbook](docs/runbook.md), [known limitations](docs/known-limitations.md),
and the latest [verification report](docs/verification-report.md).
