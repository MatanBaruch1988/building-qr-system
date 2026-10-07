# Branch rulesets for the default branch

The rulesets apply to the repository's default branch (`~DEFAULT_BRANCH`: `master` here, often `main` in a copy), so a
copy needs no edit to them. The file names keep `master` from this repository.

`master-gates.json` protects the default branch for everybody, with no bypass: it cannot be deleted or force-pushed,
every change arrives through a pull request that is squash-merged (no approval is needed, so you can merge your own),
and the branch must be up to date with the default branch with all four CI checks green: `guards`, `unit`, `e2e (android-chrome)`
and `e2e (iphone-webkit)` (the job names in `.github/workflows/ci.yml`). Each check is bound to GitHub Actions
(`integration_id` 15368 is the GitHub Actions app), so nothing else can report a status under the same name.

`master-approval.json` adds a second person: one approving review is required, it must come from a code owner
(`.github/CODEOWNERS`), and it does not survive a push made after it (stale reviews are dismissed). The repository admin
role may bypass it on a pull request, and that is every repository administrator, not only the owner. GitHub cannot tell
the owner from an agent that runs with the owner's own `gh` login or token, so a local agent could merge as an admin:
local agents must never merge. `.claude/settings.json` denies `gh pr merge` to Claude Code, but that is a guardrail
against the usual command, not a security boundary (`docs/adr/0003-the-reviewer-is-from-another-vendor.md`): the habit of
never merging matters more than the setting. An agent in GitHub Actions runs as its own app, which is not an admin, so
it needs the approval like anybody else. The two rulesets add up, so the checks and the squash rule still hold.

The agent loop (`.github/workflows/claude.yml`, ADR 0006) works through the Claude GitHub App: it pushes branches
named `claude/...` and comments, and the owner opens the pull request from the link in its comment. The app is not
an admin and is not in `bypass_actors`, so a pull request of the agent needs the owner's approval like anybody else's,
and the owner merges. The rulesets protect the default branch only, so the app can push its own `claude/` branches, but
never the default branch itself.

A pull request can change its own workflow and guard scripts, and the checks that run on it are the changed ones. So a
change under `.github/` or to `scripts/check-*` needs the owner's careful look: green checks are not proof that the
checks themselves were not weakened.

The files are the exact request body of GitHub's "Create a repository ruleset" API; a ruleset is only enforced once it
has been created that way (or in the repository settings). Apply each one once, from the repository root, and only after
the four checks have run green once (a required check that has never run blocks every pull request). `gh` fills in
`{owner}` and `{repo}` from the repository of the current folder:

```
gh api --method POST repos/{owner}/{repo}/rulesets --input .github/rulesets/master-gates.json
gh api --method POST repos/{owner}/{repo}/rulesets --input .github/rulesets/master-approval.json
```

To change one later, send the edited file with `gh api --method PUT repos/{owner}/{repo}/rulesets/<id> --input <file>`
(the ids are listed by `gh api repos/{owner}/{repo}/rulesets`).

## The merge queue (an organization's repository, without a bypassed approval)

`master-merge-queue.json` makes every pull request merge through GitHub's merge queue. A pull request is added with
"Merge when ready"; the queue builds it on top of the default branch and of the pull requests ahead of it, runs the four
checks there (the `merge_group` trigger in `ci.yml`), and squash-merges it only if they pass ("all green"; one pull request
is enough to start, with no waiting). So nobody brings a pull request up to date by hand any more, and two pull requests
that pass alone but fail together never reach the default branch. It has no bypass.

It works only when a pull request can meet every other requirement without a bypass. A pull request joins the queue only
when all of them are met, and GitHub does not count a bypass there: the repository admin's bypass of `master-approval`
merges a pull request directly, but does not let it into the queue. So with `master-approval` the queue needs a code
owner who approves each pull request and who is neither its author nor its last pusher. This repository has one
maintainer, who opens and pushes every pull request and merges with that bypass, so it does not apply the file: on
07/10/2026 it was applied, the merge box showed "Merging is blocked" with "Merge when ready" greyed out and no bypass, and
the ruleset was removed the same day. The file stays for a copy where it works: one with a second person who approves,
or one with a single maintainer that applies `master-gates` without `master-approval` (`master-gates` requires no
approval, so there is nothing to bypass; not tried yet).

GitHub offers a merge queue only to repositories owned by an organization; a copy in a personal account skips this file.
An organization's copy where it works applies it after the other rulesets:

```
gh api --method POST repos/{owner}/{repo}/rulesets --input .github/rulesets/master-merge-queue.json
```
