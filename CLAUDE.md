# Building QR attendance app

A Vite + React SPA with two apps (provider app on `/`, committee app on `/admin`), a Vercel serverless API in
`server/` (entry `api/index.js`) and Neon Postgres. See `README.md` for the architecture and `docs/agent-api.md` for the
read-only agent API.

## Rules for every change

- Code comments are in English. The Hebrew in the UI comes from `src/i18n/*.js`.
- Never use an em dash (the long dash) anywhere: code, comments, UI text, docs. Use a regular hyphen. `tests/no-em-dash.test.js` fails `npm run test:unit` if one appears.
- The app is used on a phone and on a computer. Change both layouts together and check both.
- Dates and times that a person sees (on a screen, in the committee's CSV) are always DD/MM/YYYY and HH:MM (24 hours,
  the building's time), written only by `shared/datetime.js`: never a month name, a weekday, the browser's own date
  field or the device's locale. The API and the agent keep ISO dates on purpose (a machine must not guess day-month or
  month-day). `tests/dates.test.js` fails if another way of writing a date turns up in `src/`, `server/` or `shared/`.
- Every tile and row of the committee app lists its actions in one order, from the title to the end of the row: the
  actions of that screen, then edit, then switch off / on, and last the red trash can (red is only for deleting).
  `e2e/admin.spec.js` measures it on every screen, so a new action goes in its place in that order.
- Do not invent selectors or URLs in tests: read the real component, then use `getByRole` / `getByText` / `getByLabel`.
- If a test fails because of a real app bug, report it. Do not change the test to hide it and do not fix the app silently.

## Testing

Two layers, one command each. Both talk to the real Neon database from `.env.local`, always inside a throwaway schema
that is dropped at the end, never the real data.

| Command | What it runs | When |
|---|---|---|
| `npm run test:unit` | Vitest: logic, API against Postgres, i18n, contrast, typography, component tests (`tests/components`, jsdom + Testing Library). About 8 minutes in full. | After every logic change. For a quick loop run one file, for example `npx vitest run tests/components`. |
| `npm run test:e2e` | Playwright, two projects: `android-chrome` (Chromium, Pixel 7) and `iphone-webkit` (WebKit, iPhone 14). Builds the app and starts the API and the preview server by itself. | Before every commit that touches `src/`, `server/`, `vite.config.js` or the PWA files, and before a release. |
| `npm test` | Both, unit first. | Before a release. |

Details that matter:

- One-time setup on a new machine: `npm install`, then `npx playwright install chromium webkit` (about 350 MB).
- E2E uses ports 3100 (preview of the production build) and 3101 (API) and the scratch schema `e2e`, seeded by
  `scripts/dev-seed.mjs`. Playwright starts both servers (`playwright.config.js`); the schema is dropped before every run
  and again after it (`e2e/global-teardown.js`), so a run that was killed leaves a schema that the next run clears.
  Nothing may already be listening on those ports, and two runs cannot share them, so do not start two at once.
- The PWA is tested on the production build, because the service worker only exists there. Do not point the E2E at `vite dev`.
- A single spec or project: `npx playwright test e2e/pwa.spec.js --project=android-chrome`. A failing run keeps a trace
  in `test-results/` (`npx playwright show-trace <trace.zip>`).
- Every E2E test fails on an unexpected `console.error` or page error. A test that provokes one on purpose (a wrong
  password, a refused point, going offline) allows it with `allowConsoleErrors` in `e2e/fixtures.js`: that allows the
  message for the whole test, so keep the pattern as narrow as the message allows.
- The offline tests run on `android-chrome` only: Playwright's WebKit cannot take a service-worker page offline.
- The icons: iOS ignores an SVG as the Home Screen icon, so the PNGs in `public/` (`apple-touch-icon.png` 180x180 on a
  solid background, `pwa-192x192.png`, `pwa-512x512.png`) are made from `public/pwa-512x512.svg` by `npm run icons`.
  To change the logo, replace that SVG, run `npm run icons`, commit the PNGs. `tests/pwa-icons.test.js` and the
  `apple-touch-icon` test in `e2e/pwa.spec.js` check them.

Not automated, on purpose: Home Screen install, standalone mode, the status bar, offline use on a real iPhone, push.
Check them by hand with `docs/manual-ios-checklist.md` before a release that touches the PWA files, the layout or the
location flow.
