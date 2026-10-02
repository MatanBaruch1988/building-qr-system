# Contributing

Thank you for helping. This is a tool that building committees can host for themselves, and the maintainer's own
building is its first user. Issues and pull requests are welcome in English or Hebrew.

By taking part you agree to follow the [Code of Conduct](CODE_OF_CONDUCT.md). To report a security problem, do not open
an issue: follow [SECURITY.md](SECURITY.md).

## Before you start

- **Larger work:** open an issue first, with the bug form or the feature form, so that the approach can be agreed
  before you spend time on it.
- **Small fixes** (a typo, a clear bug with a small fix) can go straight to a pull request.
- Write about one thing at a time. Do not put real names, phone numbers, passwords, attendance records or keys in an
  issue, a pull request, a screenshot or a test.

## Set it up

1. Install Node 24 (the version is in [`.nvmrc`](.nvmrc)).
2. `npm install`
3. `npx playwright install chromium webkit` (about 350 MB, needed for the browser tests).
4. Copy `.env.example` to `.env.local` and fill in `DATABASE_URL` (and `DATABASE_URL_UNPOOLED`). Point them at a
   Postgres database of your own that holds no real data: a free Neon project, or a local Postgres 18. **Never a
   production database**, not even to look. The tests, the dev seed and the local scripts refuse a database that is
   marked as production, and an env file pulled from Vercel production (`server/dbGuard.js`, `server/loadEnv.js`).
5. Run it:

```bash
npm run db:seed-dev                  # a separate dev_ui schema with sample data
npm run dev:api -- --schema=dev_ui   # the local API (port 3001), with a dev-only admin sign-in that skips Google
npm run dev                          # the app (port 3000)
```

The [README](README.md) has the rest (it is written in Hebrew). The Google sign-in setup there is only needed to host
your own deployment, not to work on the code.

## The project rules

The full list is in [`CLAUDE.md`](CLAUDE.md), under "Rules for every change". The ones that matter most:

- **No em dash** (the long dash) anywhere: code, comments, UI text, docs. Use a comma, a colon, a full stop,
  parentheses or a plain hyphen. A test fails if one appears.
- **Dates and times that a person sees** are written only by `shared/datetime.js`: DD/MM/YYYY and HH:MM (24 hours, the
  building's time). Never a month name, a weekday or the browser's own date field. The API and the agent keep ISO
  dates on purpose.
- **Phone and computer:** the app is used on both. Change both layouts together and check both.
- **UI text** comes from `src/i18n/*.js`, in all four languages: Hebrew, English, Russian and Arabic.
- **Code comments are in English.**
- **The committee app lists the actions of every tile and row in one order:** the actions of that screen, then edit,
  then switch off / on, and last the red trash can (red is only for deleting).

## Tests

```bash
npm run test:unit     # Vitest: logic, the API against Postgres, i18n, contrast, typography, components
npm run test:e2e      # Playwright: Chromium as a Pixel 7 and WebKit as an iPhone 14
npm test              # both
```

For a quick loop, run one file: `npx vitest run tests/<file>.test.js`. The unit tests and the E2E tests both create a
throwaway schema in your database and drop it at the end.

CI runs on every pull request, against a Postgres 18 container, and four checks are required to merge:

- `guards`: migrations only move forward, tests are not removed, the pull request title, a dependency audit
- `unit`
- `e2e (android-chrome)`
- `e2e (iphone-webkit)`

**Never delete or skip a test to make CI pass.** If a test fails, either your change has a bug or the app has one:
fix it, or report it in the pull request. Do not change the test to hide it.

## Database changes

A migration is a **new numbered file** in `db/migrations/`, one number after the last. Never edit, rename or delete an
old one: a migration that has run is history, and you fix forward with a new file.

Destructive SQL (drop, rename, truncate, delete, a type change, `SET NOT NULL`) needs a line
`-- contract: <reason>` that says why it is safe now.

Work in three steps, in separate releases: **expand** (add the new column or table), **migrate** (move the data and
switch the code to it), then **contract** (drop what the old code used). The old deployment keeps serving while the
new one builds, and installed apps keep running old code for days, so the database and the API must work for both.

## Pull requests

- Keep it small and about one thing.
- The title is a Conventional Commit: `type(scope): description`, where the
  scope is optional. The types are `feat`, `fix`, `docs`, `chore`, `refactor`, `perf`, `test`, `build`, `ci`, `style`
  and `revert`. For example: `feat(admin): export attendance to CSV` or `fix: refuse a scan from too far away`.
  A check refuses any other title.
- Fill in the pull request template.
- Pull requests are squash-merged, and the title becomes the commit on `master`. The maintainer reviews and merges.
- An automated Codex review may comment on your pull request. Its findings are advice to check, not orders: reply if
  you disagree.

## Working with AI tools

AI-assisted contributions are welcome. You are responsible for every line you submit, whoever or whatever wrote it:
read it, run it, and understand it. Say in the pull request template which tool helped. Never paste secrets or real
personal data into a prompt, an issue or a test.

The "Agent task" issue form is for tasks that are written so that a coding agent can do them without more questions.
Filling it in does not start any agent: only the maintainer starts one, after reading the issue.

## License

By contributing, you agree that your contribution is licensed under the project's [MIT license](LICENSE).
