# Screenshots

The pictures of the two apps that the project's README shows, so that a person who finds the repository sees what it looks
like before installing anything. Both apps are in Hebrew, in the light theme (one picture is dark).

**They show only the fake sample data** that `scripts/dev-seed.mjs` makes in a scratch schema (an invented building, five
invented providers, four points on an invented position, and sixteen visits that `scripts/screenshots/seed-history.mjs`
adds). No real name, address, phone number or coordinate is in them, and none may be: look at every picture before you
commit it. The dates and times in them are relative to the day that they were taken: the visits are one to five days old, and
the check-in of the provider app is made at the moment of the run.

| Image | What it shows |
|---|---|
| `provider-phone-sign-in.png` | The provider app on a phone: a scan link opens the list of names to pick from |
| `provider-phone-check-in.png` | The same app after signing in: the check-in is recorded |
| `provider-phone-saved-offline.png` | The same app with no network: the visit is kept on the phone and is sent by itself later |
| `committee-phone-points.png` | The committee app on a phone: the Points tab |
| `committee-phone-history.png` | The committee app on a phone: the History tab, scrolled to the visits |
| `committee-computer-points.png` | The committee app on a computer (1280 px wide): the Points tab with the side rail |
| `committee-computer-history.png` | The same, the History tab |
| `committee-computer-help.png` | The same, the Committee tab with the help ("How to work with the system") open |
| `committee-computer-points-dark.png` | The same, the Points tab in the dark theme |

Phone pictures are 390 px wide, drawn at twice the density. Every image is a PNG of at most 300 KB (the script refuses a bigger
one, and `tests/screenshots.test.js` fails on one that is committed).

## Taking them again

```
npm run screenshots
```

It builds the production app, starts the local API over a scratch schema with the sample data, drives both apps in Chromium
and writes the images here, replacing the old ones. It needs what the end-to-end tests need: the non-production database of
`.env.local` (or a local PostgreSQL), and `npx playwright install chromium`.

- It runs on ports 3300 and 3301 and in the schema `screenshots`, which it drops before and after the run, so it can run next
  to the development servers and to an E2E run.
- **It refuses to run against anything but `http://localhost` or `http://127.0.0.1` and a scratch schema** (never `public`,
  `dev_ui`, `neon_auth` or the E2E run's own `e2e`). The guard is `assertLocalScratch` in `scripts/screenshots/settings.mjs`.
- It is not part of `npm run test:e2e` and CI never runs it: its config, `playwright.screenshots.config.js`, reads
  `scripts/screenshots/`, not `e2e/`.
- Every run rewrites every image, because the times in them change. Commit them only when a screen has changed.

To add a picture, add a step to `scripts/screenshots/screenshots.spec.mjs`, run the command, look at the new image, and add its
row to the table above.
