@AGENTS.md

## Claude Code only

- The shared settings are in `.claude/settings.json` (committed). They deny reading `.env`, `.env.local`,
  `.env.*.local`, `.env.production` and `.vercel/**` (`.env.example` stays readable on purpose), and they deny
  `gh pr merge`, `vercel --prod`, `vercel deploy --prod`, `vercel env pull` and `git push --force` / `-f`. They also deny
  what makes a release, which is the owner's alone (AGENTS.md, "Releases"): `gh release create`, `edit`, `delete` and
  `upload`, `gh workflow run release.yml` and `gh workflow run Release`, `git tag` and pushing tags (`git push --tags`,
  `git push origin v*`). This is a guardrail against the usual command, not a security boundary (ADR 0003): when a deny
  rule blocks something, do not look for another way to do it (`gh api` included), ask the owner.
- The same file wires an edit hook: after every Edit, Write or MultiEdit, `scripts/hooks/check-edit.mjs` checks the file
  for an em dash and, in `src/`, `server/` and `shared/`, for a date that `shared/datetime.js` did not write. The rules
  are in `scripts/text-rules.mjs`. If the hook reports a problem, fix it before moving on: the edit is already saved.
- Personal settings go in `.claude/settings.local.json`. It is ignored by git, like everything else in `.claude/`
  except `settings.json`.
- The working split: plan with Opus, execute with Sonnet, and the reviewer is Codex (ADR 0003,
  `docs/adr/0003-the-reviewer-is-from-another-vendor.md`).
