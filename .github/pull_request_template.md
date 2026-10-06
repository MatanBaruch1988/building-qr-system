<!-- The title must be a Conventional Commit, for example "fix: refuse a scan from too far away". Squash merge makes it the commit on the default branch. -->

## What and why

<!-- What does this change, and why? One thing per pull request. -->

Closes #

## How it was checked

<!-- The commands you ran, for example npm run test:unit and npm run test:e2e. -->
<!-- For a change that people can see: a screenshot on a phone and one on a computer. Cover all personal data first. -->

## Written with

<!-- Tick all that apply. You are responsible for every line, whoever wrote it. -->

- [ ] Human only
- [ ] Claude Code
- [ ] Codex
- [ ] Other:

## Checklist

- [ ] The title is a Conventional Commit.
- [ ] Tests are added or updated, and none is removed or skipped.
- [ ] It is backward compatible: the API and the offline sync payload still accept old clients, because installed apps keep running old code for days.
- [ ] A migration is a new file only (expand first, contract later), and destructive SQL has a `-- contract: <reason>` line. Or: there is no migration.
- [ ] Dates and times that a person sees go only through `shared/datetime.js`.
- [ ] UI text of the service providers' app is in all four languages (`src/i18n/*.js`); the committee app's is Hebrew for now.
- [ ] There is no em dash anywhere.
- [ ] There are no secrets and no real personal data in the code, the tests, the screenshots or the logs.
