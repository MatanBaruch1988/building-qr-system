# 0001: CI runs on a Postgres container, not on Neon branches

Status: Accepted

Date: 02/10/2026

## Context

The unit tests and the end-to-end tests need a real Postgres: the API tests run migrations and queries, and the E2E
tests run the whole app on top of it. Production is Postgres 18 on Neon. The pipeline (`.github/workflows/ci.yml`) has to
run on every pull request, including pull requests from agents, and the repository is public.

## Decision

The `unit` and both `e2e` jobs start a Postgres 18 service container next to the job and run against it. The image is
pinned to a digest (`postgres:18@sha256:...`), like every action is pinned to a commit SHA, because a tag moves with every
patch release. The URLs are plain `postgres://` URLs without `sslmode`, so the container is reached without TLS. The tests
still create a throwaway schema in it and drop it at the end.

## Consequences

Good:

- No database credentials are stored in GitHub. A workflow run, or a pull request that changes the workflow, has nothing
  to leak.
- No personal data is copied. A Neon branch is a copy of its parent, and the parent holds the committee's real
  attendance data.
- It is fast (no cold start, no network) and free, with no quota to run out in a busy week.
- Every run starts from an empty database, so a test cannot depend on what an earlier run left behind.

Bad:

- Neon-specific behaviour is not covered in CI: the connection pooler, the cold start of a suspended compute, the
  difference between the pooled and the direct URL. It is covered only by the local runs against the non-production Neon
  project (ADR 0005) and by looking at production after a release.
- The digest is updated by hand. Dependabot does not update the image of a service container in a workflow. To move it,
  resolve `postgres:18` again and replace the digest in the `unit` and the `e2e` jobs.
- When production moves to another Postgres major version, the image has to move with it.

## Alternatives considered

- **A Neon branch per pull request.** It matches production most closely, but it needs a Neon API key in GitHub, it copies
  the production data into a branch that a pull request's code can read, and it counts against the plan's limits.
- **One shared non-production Neon database for CI.** It still needs credentials in GitHub, and two runs at the same time
  would share state.
- **An in-process Postgres emulator.** It needs no container, but it is not the same engine, and a test that passes on an
  emulator proves less about SQL, locks and migrations.
