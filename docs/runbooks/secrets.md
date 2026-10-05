# Secrets and credentials

Every secret and credential that the project uses, where it lives, who can rotate it, and when it expires or was last
rotated. The repository is public, so none of the values is ever written in a file of the repository, an issue, a pull
request, a log or a chat: they go into a secret store, through a prompt and never on a command line (`AGENTS.md`, Safety).
If one leaks, revoke it first and clean the files after (ADR 0004), then rotate it with the row below.

When you create or rotate one, write the date in the "Last rotated or created" column, in the same pull request or the next
one. Dates are DD/MM/YYYY.

| Secret | Where it lives | Who can rotate it | Expires | Last rotated or created |
|---|---|---|---|---|
| `CLAUDE_CODE_OAUTH_TOKEN` | GitHub Actions secret of the repository. Read by `claude.yml` and `claude-review.yml` only | The owner (a repository admin sets the secret; the token comes from the owner's Claude subscription) | About one year after it is made | 04/10/2026 (expires about 04/10/2027) |
| `SMOKE_AGENT_KEY` | GitHub Actions secret of the repository. Read by `smoke.yml` only | The owner, or a committee member who can open the Agent tab of `/admin` (to make and revoke the key) | Never, until it is revoked | 03/10/2026 |
| The production database credentials (`DATABASE_URL`, `DATABASE_URL_UNPOOLED`) | Vercel only: the Production environment, marked sensitive. Never in GitHub, never in `.env.local` | The owner, in Vercel | Never, until rotated | 03/10/2026 |
| `CRON_SECRET` | Vercel only: the Production environment, marked sensitive. Never in GitHub, never in `.env.local`, never in the Preview or Development environments | The owner, in Vercel (a long random value, see below) | Never, until rotated | 05/10/2026 |
| `MIGRATION_GITHUB_TOKEN` | Not used. Only a private fork needs it, in its Vercel project, so that the build can read the migrations from GitHub (`deploy-and-rollback.md`) | The owner of that fork | Set by the owner of the fork when the token is made | Not applicable |
| `GOOGLE_CLIENT_ID` | Vercel (Production) and `.env.local`. It is public by nature: it is in the code that every browser loads | Nobody needs to rotate it: it identifies the app, it does not protect anything | Never | Not applicable |
| Agent keys of the committee's own AI agent | The secrets vault of the agent platform that the committee uses, never in a chat (`docs/agent-prompt.md`) | The committee, in the Agent tab of `/admin` | Never, until revoked | Each key shows its own date in the Agent tab |
| The Neon CLI and Vercel CLI logins | The owner's computer, in the profile folder of each CLI | The owner | Until the owner signs out or revokes them | Not tracked: sign out when a computer is lost or lent |

Not stored anywhere, nothing to rotate: the `GITHUB_TOKEN` of each workflow run (it ends with the run) and the token of the
Claude GitHub App that the action gets for each agent run (it is short-lived and the action revokes it at the end).

## `CLAUDE_CODE_OAUTH_TOKEN`

Used by the agent loop (`.github/workflows/claude.yml`, `.github/workflows/claude-review.yml`, ADR 0006). It lets the
action use the owner's Claude subscription, so there is no API key to pay for.

- **Create or rotate.** On the owner's computer run `claude setup-token`, then from the repository folder run
  `gh secret set CLAUDE_CODE_OAUTH_TOKEN` and paste the token at the prompt. Write the date in the table above.
- **Expiry.** About one year. When it has run out, an agent run fails with an authentication error in its log, and nothing
  else breaks. Rotate it the same way. Put a reminder in your calendar for 11 months after the date.
- **If it leaked** (it shows in a log, an issue or a pull request): replace the secret at once, so the old token is no
  longer used, and revoke the old token in your Claude account if its settings list it. Then look at the runs since the
  leak in the Actions tab.
- Only the owner starts an agent, so the token is read only by runs that the owner started. It is still the one secret that
  the agent's process holds, which is why `show_full_output` stays off and why the tool lists are short.

## `SMOKE_AGENT_KEY`

A read-only agent key for the database step of the smoke test (`.github/workflows/smoke.yml`, `deploy-and-rollback.md`).

- **Create or rotate.** In the Agent tab of `/admin` make a key named "smoke test", then run `gh secret set SMOKE_AGENT_KEY`
  and paste the key at the prompt. To rotate, make a new key, set the secret, and revoke the old key in the same tab.
- **If it leaked:** revoke it in the Agent tab. A refused key shows as `the agent key was refused (HTTP 401)` in the smoke
  test, and without the secret the database step is skipped with a warning and the run still passes.

## `CRON_SECRET`

The password of the daily retention job (`GET /api/cron/retention`, `server/retention.js`, `docs/privacy.md`). Vercel Cron calls
the job once a day (the `crons` entry in `vercel.json`) and sends the value of the variable `CRON_SECRET` as
`Authorization: Bearer <value>`. The route compares it with its own copy and refuses everything else. When the variable is
missing or empty the route refuses every request, so a deployment without it is safe, but the job then never runs: nothing is
deleted, and the daily call shows as a 401 in the Cron Jobs log of Vercel.

- **Create or rotate.** Make a long random value on your computer, for example in Git Bash: `openssl rand -hex 32`. Copy it
  from the terminal, and in the Vercel project open Settings, Environment Variables, add `CRON_SECRET` for the **Production**
  environment only, mark it sensitive and paste the value there. No spaces or line breaks in it. Never type the value into a
  command line that the shell keeps in its history, and never into a chat, an issue or a pull request. Then redeploy: a new
  value reaches only the deployments that are built after it is set. Write the date in the table above.
- **Check that it works.** In Vercel, Settings, Cron Jobs, run the job once, and open its log: a line that starts with
  `retention:` followed by three counts means that it ran. (Vercel Cron only calls the production deployment, so the
  Preview and Development environments do not need the variable.)
- **If it leaked:** set a new value as above and redeploy. Whoever held the old value could only start the same job that runs
  every day anyway, and it deletes only what is past its period, so the harm is small, but replace it all the same.

## The production database credentials

They live only in Vercel (Production environment, sensitive), so they never reach GitHub or an agent. Vercel builds with them
and migrates production in the production build (ADR 0002).

- **Rotate.** In Vercel, use Rotate Secrets for the database credentials, then redeploy so that the new deployment holds
  the new ones. After a rotation check `/api/health/db` with an agent key (`incident.md`).
- Last rotation: 03/10/2026, with Vercel's Rotate Secrets followed by a redeploy.
- Never pull them to a computer: `vercel env pull` from Production is forbidden (`AGENTS.md`), and the local `.env.local`
  points at a non-production Neon project.

## Rotation log

One line per creation or rotation, with no value in it.

- `03/10/2026`: the production database credentials were rotated with Vercel's Rotate Secrets, followed by a redeploy.
- `03/10/2026`: `SMOKE_AGENT_KEY` was set as a GitHub Actions secret (an agent key made in the Agent tab of `/admin`).
- `04/10/2026`: `CLAUDE_CODE_OAUTH_TOKEN` was created with `claude setup-token` and set as a GitHub Actions secret.
- `05/10/2026`: `CRON_SECRET` was set by the owner in the Production environment of Vercel (sensitive), for the daily retention job.
