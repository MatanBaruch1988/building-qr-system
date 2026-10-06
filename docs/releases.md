# Releases

Other buildings install their own copy of this repository, one building per installation. They need to know which
version they run, what changed in the next one, and above all **what they must do when they update**. A release is how
that is said: a tag (`v2.1.0`) and a GitHub release with notes. This page explains the version numbers, how the owner
cuts a release, and why it is done this way.

Where the parts are:

| What | Where |
|---|---|
| The workflow that creates the draft release | [`.github/workflows/release.yml`](../.github/workflows/release.yml) |
| The script that writes the notes | [`scripts/release-notes.mjs`](../scripts/release-notes.mjs), tested in [`tests/release-notes.test.js`](../tests/release-notes.test.js) |
| The releases themselves | the Releases page of the repository on GitHub |

## The version number

A version is `MAJOR.MINOR.PATCH` (SemVer), and the tag is the same with a `v` in front. It is written for the person who
installs, so each number says what that person has to do:

| Number | When | What an installer does |
|---|---|---|
| **MAJOR** (`v3.0.0`) | An installer must act: a new setting (an environment variable, a Google or Vercel setting), a manual step (a command to run, something to change by hand), or anything else that breaks an installation that just pulls the new code. | Reads "What installers must do" and does it. A major version always has something there. |
| **MINOR** (`v2.1.0`) | New features. | Updates. Nothing else is needed. |
| **PATCH** (`v2.0.1`) | Fixes only. | Updates. Nothing else is needed. |

Pull request titles are Conventional Commits (see [CONTRIBUTING.md](../CONTRIBUTING.md)), and the notes are made from them
(below). A title with a `!` before the colon (`feat(api)!: ...`) is listed under **Breaking changes**, which is a sign that
the next version is a MAJOR one. The owner decides the number: the script only checks that it is greater than the
previous one.

A security fix is released the same day that it merges (`SECURITY.md`). A release holds everything that merged since the
previous one, so its number follows all of it, as for any release: a PATCH when only fixes merged since, a MINOR when a
feature merged in between, a MAJOR when installers must act.

## How to cut a release

The owner does it, by hand, from the default branch, when something worth installing has merged. There is no schedule.

1. **Run the workflow.** In the repository on GitHub: Actions, Release, Run workflow, on the default branch, with the
   version without the `v` (for example `2.1.0`). Or from the repository folder:

   ```bash
   gh workflow run release.yml -f version=2.1.0
   ```

   Leave `previous` empty: the workflow compares with the newest `v*` tag that is an ancestor of the commit, and with
   nothing for the first release. To compare with another tag, give it (`-f previous=v2.0.0`).
2. **If the run fails, read its message.** It fails, and creates nothing, when the version is not three numbers
   (`2.1.0`), when it is not greater than the previous tag, when the previous tag does not exist or is not behind the
   commit, when nothing changed since it, or when the tag or a release for that version already exists. Fix the input
   and run it again. It does not run from any other branch than the default one: such a run shows as skipped.
3. **Open the draft.** The Releases page shows it as a draft (`gh release view v2.1.0 --web` opens it). Check the
   groups: each line is a pull request title as it was merged, with the number linked to the pull request. A line that
   reads badly can be edited in the draft (the history stays as it is).
4. **Write "What installers must do".** The section is empty, with a comment for you in the editor. Write what an
   installer must do before or after updating, in the order they do it, or write `Nothing.` when there is nothing. A
   major version always has something. The comment is invisible once published, but delete it anyway.
5. **Publish.** GitHub creates the tag `v2.1.0` at that moment, **on the commit the workflow ran on**, not on the tip of
   the branch on the day of publishing, so the notes and the tag always describe the same commit.

A draft that is wrong is deleted, and the workflow is run again: a draft has no tag, so there is nothing else to undo. A
published release is edited in place if only the notes are wrong. A published tag is not moved or deleted, because
installers may have pulled it: a mistake in the code is fixed by the next PATCH version.

## Why a draft

- The script knows what was merged. It cannot know what an installer has to do about it: a new variable, a command to
  run, an order of steps. Only a person can write that, and it is the part of the notes that installers need most.
- Publishing creates the tag and tells everyone who watches releases. The owner decides when.
- A draft creates no tag and changes nothing in the repository, so a run that went wrong costs nothing.

## Why the tag is the version, and `package.json` is not

`package.json` says `"version": "2.0.0"` and it stays that way. The package is `private` and is never published to npm,
and nothing reads that number: not the build, not the server and not a script or a test. The apps show their **build
id**, which is the first 7 characters of the commit that Vercel built (`VERCEL_GIT_COMMIT_SHA`, see the README), and the
server reports its commit in `GET /api/health`.

Keeping it in step with the releases would mean a commit for every release, which means a pull request, which means a
production deployment with no change in it, only to write down a number that nobody reads and that the tag already
says. It would also give the project two version numbers that can disagree. So the tag is the only version.

To find which release an installation runs, take its build id (or the `commit` of `GET /api/health`) and ask git which tag
has it first:

```bash
git fetch --tags
git tag --contains <build id> --sort=version:refname | head -1
```

## Why not release-please

release-please (and a tool that tags every merge) was considered and left out:

- It opens its pull requests with a token that has to outlive any one run (a personal access token or an app key kept as
  a secret), because the token of a workflow cannot start the CI checks on a pull request that it opens. This
  repository keeps its list of secrets short on purpose ([runbooks/secrets.md](runbooks/secrets.md)), and a new
  long-lived one that can write to the repository is not worth a changelog.
- It turns every release into a pull request, and the merge of that pull request deploys production: a release would be
  a deployment, and the owner would be asked to merge something that changes nothing but a number.
- It writes the version into files, which is the thing the section above avoids, and it cannot write the section that
  matters most to an installer.

A workflow that is run by hand, with the token of the run, a draft, and no commit, has none of these.

## The plan

- **v2.0.0**, now, on the current state of the default branch, made after the fact: the first release. The notes say
  that it is the first tagged release and that the earlier changes are in the history. "What installers must do" says
  where a new installation starts (the README).
- **v2.1.0**, at the end of the install work, when a copy of the repository can be installed by another building. The
  install guide, [install.md](install.md), is part of that work and exists now. From then on a release is made when the
  owner decides there is something to install, and its number follows the table above.
