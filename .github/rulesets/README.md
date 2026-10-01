# Branch rulesets for master

`master-gates.json` protects the default branch for everybody, with no bypass: it cannot be deleted or force-pushed,
every change arrives through a pull request that is squash-merged (no approval is needed, so you can merge your own),
and the branch must be up to date with master with all four CI checks green: `guards`, `unit`, `e2e (android-chrome)`
and `e2e (iphone-webkit)` (the job names in `.github/workflows/ci.yml`).

`master-approval.json` adds a second person: one approving review is required, and it must come from a code owner
(`.github/CODEOWNERS`). The repository admin role may bypass it on a pull request, so the owner can still merge alone
while anybody else needs an approval. The two rulesets add up, so the checks and the squash rule still hold.

Both files are the exact request body of GitHub's "Create a repository ruleset" API; a ruleset is only enforced once it
has been created that way (or in the repository settings). Apply each one once, from the repository root, and only after
the four checks have run green once (a required check that has never run blocks every pull request):

```
gh api --method POST repos/MatanBaruch1988/building-qr-system/rulesets --input .github/rulesets/master-gates.json
gh api --method POST repos/MatanBaruch1988/building-qr-system/rulesets --input .github/rulesets/master-approval.json
```

To change one later, send the edited file with `gh api --method PUT repos/MatanBaruch1988/building-qr-system/rulesets/<id> --input <file>`
(the ids are listed by `gh api repos/MatanBaruch1988/building-qr-system/rulesets`).
