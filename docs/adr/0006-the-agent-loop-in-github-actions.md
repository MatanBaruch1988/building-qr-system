# 0006: The agent loop runs in GitHub Actions

Status: Accepted

Date: 03/10/2026

## Context

Most of the code is written by AI coding agents and the owner reads and merges (ADR 0003). Until now an agent only worked
in a session on the owner's computer. The owner wants to write a task as an issue, start it with one click and read the
result as a pull request, from a phone if needed. Four facts shape the answer:

- The owner approves merges and nothing else: no agent merges, approves or pushes to `master`.
- The project uses subscriptions only. There is no paid API key, so the action authenticates with
  `CLAUDE_CODE_OAUTH_TOKEN`, a token that `claude setup-token` makes for a Claude Pro or Max subscription.
- Codex reviews through the ChatGPT GitHub integration, which is not a workflow, so only Claude needs a workflow.
- The repository is public. Anybody can open an issue or comment, and an agent reads text as a prompt.

## Decision

Two workflows run `anthropics/claude-code-action`, pinned to a commit SHA like every action.

- `claude.yml`: Claude implements an agent task. The owner adds the label `agent:go` to an issue, and Claude (Sonnet 5.5,
  30 turns, 45 minutes) works on a branch `claude/...`, runs the checks from the issue and pushes. Its comment on the issue
  ends with a pre-filled link, and the owner opens the pull request: the action does not create pull requests itself, and
  that is kept, because the click is a human look at what is about to be proposed. A comment with `@claude` written by the
  owner on a pull request of this repository makes Claude address the review findings on the same branch.
- `claude-review.yml`: Claude reviews a pull request that Codex wrote (the branch starts with `codex/`) or any pull request
  with the label `review:claude`. It posts one comment under the "Code Review Rules" of `AGENTS.md` and has no tool that
  changes code. It does not run on every push or for Dependabot, because of the quota.
- Only the owner starts an agent, never from a fork. The workflow checks the sender, the action refuses bots and actors
  without write access, and `allowed_bots` and `allowed_non_write_users` are never set. At most 2 agent pull requests are
  open at a time. The shell is limited to listed commands, with no network tool, no merge and no force-push.
- The agent holds no production secret. It sees this public repository and a throwaway Postgres container.
  Untrusted text (comments of strangers) is filtered out, a task written by a stranger is rewritten by the owner first,
  and nobody else can start the run: that cuts the "lethal trifecta" (untrusted text, private data, a way out).
- The runner starts with harden-runner in audit mode. The endpoints that Claude Code, npm and Playwright need are not known
  yet, so the first runs list them in StepSecurity's insights and a later change switches to `block` with that list.

## Consequences

Good:

- A task can be started and read from anywhere, and every change still goes through CI, Codex and the owner's merge.
- Both directions of ADR 0003 exist: Codex reviews Claude's pull requests, Claude reviews Codex's.
- The cost is the owner's existing subscription, capped by turns, minutes and the number of open pull requests.

Bad:

- Quota: the runs use the same subscription limit as the owner's own sessions. Starting by label only and reviewing only
  Codex pull requests keep that small, and a quota problem stops the loop, not the project (a review does not block a merge).
- The token expires in about a year. A run then fails with an authentication error until the owner makes a new token and
  updates the secret (`docs/runbooks/secrets.md` holds the date).
- The action checks that a workflow file is the one on the default branch, so it skips (with a warning) on the pull
  request that adds or changes these files. The first real test is after the merge, on a small issue.
- The process that runs Claude holds the Claude token and a short-lived token of the Claude GitHub App for this
  repository, and the code that Claude runs (the tests) runs in it. Audit mode does not block a leak: it shows one.
  The owner-only trigger, the tool lists and the later `block` are what hold.
- The Claude GitHub App cannot change workflow files, so a change to CI is always a human one. Whether a push by the app
  starts CI on an existing pull request is not stated in the action's documentation: the first run shows it. If CI does
  not start, close and reopen the pull request.
- It depends on a third-party action and on its token exchange, which Dependabot moves by SHA and the owner reviews.

## Alternatives considered

- **Codex cloud writes the pull requests and Claude reviews them.** Supported: it is `claude-review.yml` with the branch
  `codex/`. The owner picks the writer per task, and the other vendor reviews.
- **A self-hosted runner on the owner's computer.** Rejected: on a public repository it would run text from outside next
  to the owner's files and logins.
- **A paid API key.** Rejected: the project uses subscriptions only.
- **Claude opens the pull request itself (`gh pr create`).** Rejected: not the action's default, and the owner's click is
  the point of the review.
- **An agent that merges after green CI.** Rejected for the reasons in ADR 0003.
- **Block the network now.** Not yet possible: the endpoints are not known, and a wrong list stops the loop.
