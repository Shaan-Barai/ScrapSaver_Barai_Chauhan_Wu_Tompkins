# tests/integration

Offline cross-system checks (`node:test`, no Gemini, camera, or live API):

- `calibrate-capture.test.mjs` — the real `capture/` calibrate → capture CLIs against a fake backend.
- `no-stale-data-filenames.test.mjs` — guard: the old factor/menu data file names do not come back.

## Run

```bash
cd tests
npm test                  # these + the e2e placeholders
npm run test:integration  # these + tests/system/ (builds packages first)
```

Live end-to-end checks live in `../e2e/`, `../system/` and `../live/`; see [docs/testing.md](../../docs/testing.md).
