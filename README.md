# Building attendance with QR

[![OpenSSF Scorecard](https://api.scorecard.dev/projects/github.com/MatanBaruch1988/building-qr-system/badge)](https://scorecard.dev/viewer/?uri=github.com/MatanBaruch1988/building-qr-system)

The app's interface is available in Hebrew, English, Russian and Arabic. The repository itself (code, documents, issues
and pull requests) is written in English.

A tool for a building committee and the service providers it hires (a cleaning company, a gardener):

1. **The committee** defines points in the building and prints a sign with a QR code for each one.
2. **The service provider** scans the QR code with the phone camera. After a one-time sign-in with a personal password,
   every scan is a single tap.
3. Every scan is stored as one row in a clean database. **The app analyses nothing**: an AI agent reads the data through
   a read-only API ([docs/agent-api.md](docs/agent-api.md)).

## How it is built

| Part | What |
|---|---|
| Service provider app | `/` and `/scan?code=…`. Hebrew / English / Russian / Arabic, and it works without a signal too (a local queue on the phone that uploads by itself). Code in `src/worker`, `src/i18n`, `src/pages/WorkerApp.jsx` |
| Committee app | `/admin`. Sign-in **only with a Google account** that is on the committee list. Points, service providers, history, agent keys. Code in `src/admin` |
| API | One Vercel function (`api/index.js`, to which `vercel.json` routes every `/api/*`) that runs `server/`. Postgres (Neon) through `pg`. The router checks who may call a route before any code of its handler runs: a route is protected by default, and only the `PUBLIC` list in `server/access.js` answers without credentials |
| Database | `db/migrations/*.sql`. Scans are append-only: they can only be voided, and a single row can be deleted only from the committee screen. A point, a service provider, a committee member or an agent key can be deleted, and their history stays with the name that was recorded |

**The location policy ("soft GPS")**: a scan is refused when there is an accurate position that is clearly far from the
point. With no signal or with a weak position the attendance is recorded and flagged `location_unverified`, except at a
point that is set to `required`: there a scan without a position is refused. Every point can be set to `required` /
`optional` / `none` (for basements).

## Local development

```bash
npm install
cp .env.example .env.local        # and fill in DATABASE_URL (see below)
npm run db:seed-dev               # a separate dev schema (dev_ui) with sample data: it does not touch the real data
npm run dev:api -- --schema=dev_ui   # the local API server (port 3001) + a dev-only admin sign-in that skips Google
npm run dev                       # the app (port 3000, it forwards /api to 3001)
npm run test:unit                 # vitest: logic, API, components (they create a temporary schema and drop it)
npm run test:e2e                  # Playwright: a real browser, a Pixel (Chromium) and an iPhone (WebKit)
npm test                          # both
```

The browser tests need a one-time install of the browsers: `npx playwright install chromium webkit`.
What cannot be tested automatically (installing to the Home Screen on an iPhone and more) is listed in
[docs/manual-ios-checklist.md](docs/manual-ios-checklist.md).

The sample users are defined in `scripts/dev-seed.mjs` (development passwords only, they exist only in the `dev_ui`
schema).

Coding agents (Claude Code, Codex) work by [AGENTS.md](AGENTS.md), and the decisions behind the rules are documented in
[docs/adr/](docs/adr/).

## Setting up the site (once)

1. [Google Cloud Console](https://console.cloud.google.com/apis/credentials) → **Create credentials → OAuth client ID → Web application**.
2. **Authorized JavaScript origins**: the address of the site (for example `https://building-qr-system.vercel.app`) and `http://localhost:3000` for development.
3. If the consent screen is in Testing mode: add the committee's Gmail addresses under **Test users** (or publish the app).
4. Copy the Client ID into `GOOGLE_CLIENT_ID` in Vercel (Production) and in `.env.local`.
5. Add the first committee member of the site. The command `npm run db:create-admin` writes to the database in `DATABASE_URL`, and in `.env.local` that is the development database (not Production), so without preparation it would add the member there and not to the site. To add the first committee member of the site, run it with the direct connection string of the site's database, which you give only to this command:

   ```powershell
   $env:DATABASE_URL = '<connection string>'; npm run db:create-admin -- you@gmail.com "Your Name"; Remove-Item Env:DATABASE_URL
   ```

   ```bash
   DATABASE_URL='<connection string>' npm run db:create-admin -- you@gmail.com "Your Name"
   ```

   The command prints which database it writes to (the address with its middle hidden and no password, and the database's marker if it has one): check that it is the address of the site's database and that it does not say `nonprod`. The connection string is a secret, so it does not go into any file in the repository. You add the others from the Committee tab ("ועד").
6. Set the building's address, which the service providers' app shows at the top, in the committee app: the Committee tab ("ועד"), building details card ("פרטי הבניין"). It is stored in the site's own database and starts empty, and while it is empty that app shows no address line.

## The move from the old system (Firebase): done

The move was completed on 01/10/2026. What is left of it:

- **The data** was imported into Postgres (`npm run db:import-firestore -- <export folder>`: a dry run without writing first, then again with `--apply`). The printed QR codes were kept as they are. **Passwords were not migrated** (the old ones were unsalted SHA-256), so new passwords were set in the Service providers tab.
- **The backup** of Firestore (JSON files) is kept outside git, in the folder `../backups/firestore-2026-10-01`. The export script and its dependencies were removed.
- **The QR codes that are already printed** point to `building-qr-system.web.app`. The small redirect site in `legacy-redirect/` forwards them to the new address (and clears the old PWA from the phones). If the public address changes, update `NEW_ORIGIN` in `legacy-redirect/public/index.html` and deploy again: `cd legacy-redirect && firebase deploy --only hosting`.
- **Firestore is locked** (`legacy-redirect/firestore.rules`: deny everything) and the old data stays in it as a backup. When you decide the backup is no longer needed, you can delete the project in Firebase, after the printed QR codes have been replaced or the redirect site is no longer needed.
- **The Firebase Vercel variables** were deleted.

## Structure

```
api/index.js           the Vercel entry point (every /api/* is routed to it in vercel.json)
server/                the API: routes/, access (who may call what, enforced by the router), auth, scans (the rules), google (verification), db, migrate
shared/                code that runs in both the browser and the server: shared/datetime.js writes every date and time a person sees, always DD/MM/YYYY and HH:MM
db/migrations/         the DB schema
scripts/               migration, creating an admin, the development seed, import from Firestore, the CI guards
src/worker, src/i18n   the service provider app
src/admin              the committee app
tests/                 vitest (logic, the API against a real Postgres in a temporary schema, i18n, import, tests/components for components)
e2e/                   Playwright (PWA, the service provider app, the committee app) on a Pixel and an iPhone
legacy-redirect/       a redirect site for the old printed QR codes
```

## Open source

The project is open under the MIT license ([LICENSE](LICENSE)): any building committee can install it and run it for
itself.

- **Contributing** (a bug, an idea or code): [CONTRIBUTING.md](CONTRIBUTING.md). Please write in English.
- **A security problem**: report it privately, not in a public issue. The explanation is in [SECURITY.md](SECURITY.md).
- **Code of conduct**: [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).
