# The redirect site for the old printed QR codes

This folder belongs to the first installation only. A new installation does not use it, and may delete the folder. It is
what is left of the move from the old Firebase app, which was completed on 01/10/2026.

## The redirect site

The QR codes that were already printed point to the old address, `building-qr-system.web.app`. The small site in
`public/` forwards them to the new address, and clears the old PWA from the phones.

If the public address changes, update `NEW_ORIGIN` in `public/index.html` and deploy again:

```bash
cd legacy-redirect
firebase deploy --only hosting
```

## What was done in the move

- **The data** was imported into Postgres (`npm run db:import-firestore -- <export folder>`: a dry run without writing
  first, then again with `--apply`). The printed QR codes were kept as they are.
- **Passwords were not migrated.** The old ones were unsalted SHA-256, so new passwords were set in the Service providers
  tab.
- **The backup** of Firestore (JSON files) is kept outside git, in the folder `../backups/firestore-2026-10-01`, a sibling of
  the repository folder. The export script and its dependencies were removed.
- **Firestore is locked** (`firestore.rules`: deny everything), and the old data stays in it as a backup. When you decide
  that the backup is no longer needed, you can delete the project in Firebase, after the printed QR codes have been
  replaced or the redirect site is no longer needed.
- **The Firebase variables** of the Vercel project were deleted.
