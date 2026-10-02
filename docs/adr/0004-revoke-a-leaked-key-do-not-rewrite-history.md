# 0004: A leaked key is revoked, the history is not rewritten

Status: Accepted

Date: 02/10/2026

## Context

The Firebase version of the app had a Google API key, and that key was committed to this public repository. GitHub's
secret scanning raised an alert for it. The question was how to deal with a secret that is already in the history of a
public repository.

## Decision

The key was revoked: it was deleted in Google Cloud, so it no longer works for anybody. The secret-scanning alert was then
closed as revoked. The history was not rewritten.

Rewriting the history (for example with `git filter-repo`, followed by a force-push) does not remove the secret from where
it has already gone:

- forks, clones and caches of a public repository keep the old commits, and anybody could have copied the key before it was
  noticed;
- GitHub keeps commits that are no longer on a branch reachable by their SHA, and pull request refs keep them as well;
- it changes every commit SHA, which breaks every open pull request, every link to a commit and the history that the
  rulesets and the reviews refer to;
- it gives a false sense of safety, because the key looks gone while it still works.

Revoking is what makes a leaked key harmless. A secret that is committed is treated as leaked from that moment, whatever
happens to the history afterwards.

## Consequences

Good:

- The key stops working at once, for everybody, and that is the only thing that protects the project.
- The history stays intact: SHAs, pull requests and the record of what was done.
- The rule is simple and the same every time: a secret that reaches the repository is revoked first, then removed from the
  files.

Bad:

- The old key stays visible in the history of the repository, and a scanner may keep finding it. The closed alert says that
  it is revoked.
- Each leak costs a new key and an update of every place that used the old one.

## Alternatives considered

- **Rewrite the history and force-push.** Rejected for the reasons above. It also goes against the rule that agents never
  rewrite history or force-push (`AGENTS.md`).
- **Do nothing because the key is old.** Rejected: an old key that still works is a live key.
- **Delete the repository and publish a clean one.** Rejected: it loses the history, the pull requests and the reviews, and
  it removes nothing from forks and clones.
