# 0003: The reviewer of a pull request is from another vendor than the writer

Status: Accepted

Date: 02/10/2026

## Context

Most of the code is written by AI coding agents (Claude Code and Codex), and the owner reads and merges. A model that
reviews its own work, or the work of another instance of the same model, shares its blind spots: it tends to agree with
the reasoning that produced the code. The owner needs a second opinion that fails differently. Reviews also cost quota,
and a quota problem must not stop the project.

## Decision

- The writer and the reviewer of a pull request are from different vendors. Codex reviews pull requests that Claude
  wrote, and Claude reviews pull requests that Codex wrote. On GitHub the Codex review reads the "Code Review Rules"
  section of `AGENTS.md`.
- An AI review is advice. It does not block a merge, so an exhausted quota or an unavailable reviewer does not stop work.
- Every finding is checked against the code before anything is changed. A finding that is wrong gets a short reply that
  says why. A finding that is right gets a fix and, where it can be tested, a test.
- Only the owner merges. Agents never merge, never approve and never push to `master`.

## Consequences

Good:

- Two different models look at every change, and what the first one missed is often what the second one finds. The review
  of the production guard changed its design (ADR 0005).
- The owner decides, with the review as input and not as a gate that can fail for reasons unrelated to the code.

Bad:

- Reviews can be wrong or noisy, and checking each finding costs time.
- Nothing forces a review to happen, because it does not block a merge.
- The limit of the "agents never merge" rule: a local agent runs with the owner's own GitHub login, and GitHub cannot tell
  the owner from the agent. The deny rule on `gh pr merge` in `.claude/settings.json` guards against the usual command, it
  is not a security boundary. The ruleset requires a code-owner approval, but the repository admin role may bypass it, and
  the owner is the admin. So the habit and the owner's attention matter, not only the settings.

## Alternatives considered

- **A review by the same vendor.** Cheaper and easier to set up, but it shares the blind spots that the review is for.
- **An AI review as a required check.** It would be enforced, but a quota or an outage would block every pull request.
- **Agents that merge after green CI.** Faster, but then no person has read the change, and green checks do not prove
  that the checks were not weakened (`.github/rulesets/README.md`).
- **No AI review.** Leaves the owner as the only reader of every diff.
