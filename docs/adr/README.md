# Architecture Decision Records

An ADR is one short file that records one decision that is hard to see from the code: what the situation was, what was
decided, what it costs and what else was considered. Code shows what the project does. An ADR says why, so that a person
or an agent that wants to change it knows what they are changing.

## How to add one

1. Take the next number (the files are `NNNN-short-title.md`, four digits, lower case, hyphens) and copy the structure of
   an existing record: title, Status, Date, Context, Decision, Consequences (good and bad), Alternatives considered.
2. Keep it to about 60 lines. Concrete, no filler.
3. Write the date as DD/MM/YYYY, like everywhere else in this project.
4. Add it to the index below and to the Decisions section of `AGENTS.md`.
5. Statuses: `Proposed`, `Accepted`, `Accepted, not implemented yet`, `Accepted, implemented`, `Superseded by NNNN`.

Never edit an accepted decision to change what it decided. When the decision changes, write a new ADR that says it
supersedes the old one, and change only the Status line of the old one to `Superseded by NNNN`. A typo or a broken link
can be fixed in place.

## Index

| ADR | Decision | Status |
|---|---|---|
| [0001](0001-ci-on-a-postgres-container.md) | CI runs on a Postgres container, not on Neon branches | Accepted |
| [0002](0002-production-migrations-in-the-vercel-build.md) | Production migrations run in the Vercel production build | Accepted, implemented |
| [0003](0003-the-reviewer-is-from-another-vendor.md) | The reviewer of a pull request is from another vendor than the writer | Accepted |
| [0004](0004-revoke-a-leaked-key-do-not-rewrite-history.md) | A leaked key is revoked, history is not rewritten | Accepted |
| [0005](0005-local-tooling-never-touches-production.md) | Local tooling never touches the production database | Accepted |
| [0006](0006-the-agent-loop-in-github-actions.md) | The agent loop runs in GitHub Actions: Claude implements agent tasks and reviews Codex pull requests | Accepted |
| [0007](0007-observability-in-our-own-postgres.md) | Errors and field problems are recorded in our own Postgres, and healthchecks.io carries the alerts | Accepted, implemented |
