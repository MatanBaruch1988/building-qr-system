# Install your own copy

This guide takes a technical volunteer (comfortable with GitHub, a terminal and web consoles, but not a developer of
this project) from nothing to a working installation for one building: your own copy of this repository, hosted on
your own GitHub, Vercel and Neon accounts, with Google sign-in for the committee.

> **Draft.** A trial install was done on 06/10/2026, following this guide, in a public fork owned by a free GitHub
> organization, and the guide was corrected from what it found. Every step is backed by the code and the configuration
> of this repository, and the wording of the third-party consoles (GitHub, Vercel, Neon, Google Cloud) was checked in
> the trial, except where a step is marked **(check in the trial install)**. The trial did not reach these, so they are
> still marked: `CRON_SECRET` and the Cron Jobs check (section 3.5), the `SMOKE_AGENT_KEY` secret, private vulnerability
> reporting and Dependabot (section 3.8), all of section 3.9, the Google consent screen of a new Google Cloud project
> (section 3.4: the trial used an existing project), the Neon integration route (section 3.2), watching releases, a
> second update after the first one, and conflicts in an update (section 5), and path B (section 4). Delete this note
> when they are done.

Contents: [1. What you get, and the limits](#1-what-you-get-and-the-limits) |
[2. Before you start](#2-before-you-start) | [3. Path A: fork, then import into Vercel](#3-path-a-fork-then-import-into-vercel) |
[4. Path B: the Vercel Deploy button](#4-path-b-the-vercel-deploy-button) | [5. Updating a copy](#5-updating-a-copy) |
[6. When something breaks](#6-when-something-breaks) | [7. Checklist: what you created, and where it lives](#7-checklist-what-you-created-and-where-it-lives)

## 1. What you get, and the limits

You get the whole app: the service providers' app at `/` (it works without a signal, with a queue on the phone), the
committee's app at `/admin` (points, providers, history, agent keys, the committee and its audit log), a read-only API for
the committee's own AI agent, daily jobs, and a smoke test after every production deploy. What it stores about people, and
for how long, is in [privacy.md](privacy.md).

The limits, plainly:

- **The committee app is in Hebrew only.** The service providers' app is in Hebrew, English, Russian and Arabic.
- **The building must be in Israel.** The time zone is a constant in the code (`BUILDING_TZ`, `Asia/Jerusalem`, in
  `shared/contract.js`), not a setting, and changing it is not supported. Dates are always DD/MM/YYYY and HH:MM. The
  holiday rules in the agent prompt are Israeli too.
- **Only a public copy is supported:** a public fork of this repository, which is path A. Path B and a private repository
  with `MIGRATION_GITHUB_TOKEN` are possible, but they are not checked on every release, and there is no supported private
  path.
- **One building per installation.** A second building is a second installation: its own Neon database, Vercel project
  and Google client.
- **It runs on GitHub, Vercel and Neon, and the committee signs in with Google.** Nothing else is required.
  healthchecks.io, an uptime monitor and database backups are optional.
- **Vercel's Hobby plan is for non-commercial, personal use** (Vercel's own words for it). Whether your committee fits
  is for you to judge against Vercel's fair use guidelines; if it does not, the paid plan is the answer. Hobby has no team
  features, so the Vercel project belongs to one person's account.
- **The address is printed in every QR code** (`APP_BASE_URL`). Choose it before you print a sign (section 2).
- **Parts for the first installation only, which a copy does not use:** `legacy-redirect/` (it forwards the QR codes
  that the old Firebase app printed), `npm run db:import-firestore` (the move from Firebase), and item 14 of the
  [iOS checklist](manual-ios-checklist.md).

What it costs. Every service has a free plan that this app fits on. The numbers below are the ones the runbooks rely on;
they change, so check each provider's current limits before you rely on them.

| Service | Plan | What the limit means for you |
|---|---|---|
| GitHub | Free, a public fork (a personal account or a free organization) | The checks of this repository and the rulesets of section 3.8 ran on a public fork in a free organization in the trial install |
| Vercel | Hobby, free | Non-commercial use. A repository owned by a free GitHub organization imports and deploys on Hobby, and so does a later push (the trial install did both). Runtime logs last about 1 hour (so the app records its own errors, [incident.md](runbooks/incident.md)). Cron jobs run once a day, at some point within their hour (`vercel.json` has two). Each merge to the production branch is one deployment, and Hobby allows a limited number a day |
| Neon | Free | Restoring is possible only to a point in the last 6 hours ([restore.md](runbooks/restore.md)), which is why section 3.9 offers a daily backup. A compute that has slept takes a few seconds to wake, so the first request after a quiet period is slow |
| Google Cloud | An OAuth client | Making the client cost nothing in the trial install, in an existing project. Whether a brand new project needs any payment for its consent screen is not checked **(check in the trial install)** |
| healthchecks.io, an uptime monitor | Free plans, optional | Section 3.9 |

## 2. Before you start

**Accounts.**

1. A GitHub account. A personal one is simplest, and a free GitHub organization works too: in the trial install Vercel's
   Hobby plan imported and deployed a repository owned by a free organization, and deployed a later push to it. Vercel's
   GitHub app must be installed on the account that owns your fork (section 3.3).
2. A Vercel account on the Hobby plan, signed in with that GitHub account.
3. A Neon account.
4. The Google account of the person who will be the first committee member, and a Google Cloud project (any Google
   account can make one).
5. Optional: a healthchecks.io account and an uptime monitor.

**Decide first.**

- **Who is the maintainer.** One person holds these accounts and does what the runbooks call "the owner". Write down who
  that is, and how somebody else would take over if that person is away.
- **The address.** With no custom domain it is `https://<project-name>.vercel.app`, where `<project-name>` is the name
  you give the Vercel project in section 3.3. If that name is taken, Vercel adds letters to it (the default
  `building-qr-system` became `building-qr-system-2xir` in the trial install), so confirm the real address on the
  project's Domains page after the first deploy. **Do not keep the default name `building-qr-system`**: the first
  installation's address is built from it. Every QR code you print later contains this address, so settle it, with a
  custom domain if you want one, before you print anything. Vercel comes before Google in this guide for that reason:
  the Google client (section 3.4) needs the exact address that Vercel settles when you import the project.

**Tools.** None is needed to deploy: the whole install is done in web consoles, except the GitHub settings in section 3.8,
which use the GitHub CLI.

- `git`, and the GitHub CLI `gh`, signed in (`gh auth login`), for section 3.8.
- Node 24 (the version in [`.nvmrc`](../.nvmrc)) and `npm ci` in a clone of your repository, only for the recovery
  command in section 3.6 and for backups (section 3.9).

**Rules to follow all the way through** (from [`AGENTS.md`](../AGENTS.md) and [secrets.md](runbooks/secrets.md)):

- A secret goes into the store of the service (Vercel, a GitHub secret, your password manager). Never into a file of
  the repository, an issue, a pull request, a log or a chat. When a command asks for a secret, type it at the prompt: a
  value typed inside a command stays in the shell's history.
- You do not need a `.env.local` and you do not need the `vercel` command. Never run `vercel env pull`, `vercel --prod`
  or `vercel deploy --prod`: a deploy happens only by a merge to the production branch.
- `DB_SCHEMA`, `DEV_ADMIN_LOGIN` and `API_PORT` in `.env.example` are for local development only. Never set them on
  Vercel (`DB_SCHEMA` would point the app at a scratch schema).

## 3. Path A: fork, then import into Vercel

This is the main path. A fork shares this repository's history, so a release can be brought into your copy as a pull
request (section 5), and your changes can go back as pull requests.

### 3.1 The fork

1. Open `https://github.com/building-attendance/building-qr-system` and choose **Fork**. The Fork page has Owner, Repository
   name (it fills in `building-qr-system`, and the repository's name may stay), Description and "Copy the `master` branch
   only". Pick the owner (your account, or your organization), and leave "Copy the `master` branch only" ticked.
2. The fork's default branch is `master`, and only `master` is copied. **Do not rename it.** The default branch is the
   production branch: the deploy gate asks GitHub for it on every production build
   ([deploy-and-rollback.md](runbooks/deploy-and-rollback.md)). `master` and `main` are the two names that `vercel.json`,
   `ci.yml` and `scorecard.yml` already list; any other name needs edits in those three files.
3. A fork of a public repository is public, and the migration check can read a public repository without a token, so path
   A needs no `MIGRATION_GITHUB_TOKEN` (a private repository does: section 4).
4. GitHub switches the workflows of a new fork off: the Actions tab says "Workflows aren't being run on this forked
   repository". Leave them off for now: section 3.8 turns them on at the right moment.
5. The fork copies the About box of this repository, including its website, `https://building-qr-system.vercel.app`: the
   first installation's address. On your fork's home page, choose the gear next to About and replace the website with your
   own address (you will know it after section 3.3), or clear it.

### 3.2 Neon: the database

There are two ways. Take the first for your first install: it makes the first deploy succeed.

**By hand.**

1. In the Neon console create a project. The "Create project" dialog has Project name, Region and Services:
   - Give it a name of your own.
   - **Region:** it defaults to "AWS US East 2 (Ohio)": **change it** to "AWS US East 1 (N. Virginia)", the region next to
     the Vercel function region, `iad1` (Washington, D.C., set in `vercel.json`).
   - **Postgres version:** expand the "Postgres database" row. It shows version 18 (the version the tests and the first
     installation run on) and the database name `neondb`: keep both.
   - **Services:** leave Object storage, Functions, AI gateway and Neon Auth off. The app uses none of them.

   Choose "Create project". Neon shows "Your new project was created" and a prompt for an agent: choose "Go to project".
2. In the project, choose the green "Connect" button. Its dialog has a "Connection pooling" switch, on by default. On, it
   shows the **pooled** string (its host has `-pooler` in it): that is `DATABASE_URL`. Off, it shows the **direct** string:
   that is `DATABASE_URL_UNPOOLED`. The password is hidden behind "Show password", and "Copy snippet" copies the snippet.
   Copy both strings with the real password in them. The direct string must not have `-pooler` in its host: the migration
   needs a session of its own and refuses a pooled host. Keep both in your password manager until section 3.3 puts them
   into Vercel.
3. Create nothing in the database. The first deploy creates the tables (`db/migrations/`) and marks the database as
   production. Never run `npm run db:migrate` against it: it refuses a production database.

**Through the Vercel integration.** Take this route instead of step 4 of section 3.3: import the project with no database
variables, then connect the database in the project's Storage tab (Neon, from the Marketplace), or connect an existing
Neon project from the Neon console, Integrations. Both integrations add `DATABASE_URL` and `DATABASE_URL_UNPOOLED` to the
Vercel project by themselves (Neon's documentation), and those are the two names this app reads. Leave the option of a
database branch for every preview deployment off, because this project builds no preview deployments. The first deploy
then fails at the gate, with the message that `DATABASE_URL_UNPOOLED` is not set: that is expected, and nothing is
touched. Once the database is connected, **Redeploy** **(check in the trial install)**.

### 3.3 The Vercel project, and the first deploy

1. Open `https://vercel.com/new` (or **Add New, Project**). The account menu there ("Select a Git Namespace") lists only
   your personal account at first. Choose **Add GitHub Scope** in it: that installs Vercel's GitHub app.
   - In the GitHub window that opens, choose **the account that owns the fork** (your organization, if the fork is
     there). The app installed on another account does not see your fork: in the trial, the first try went to the wrong
     account and the organization's Installed GitHub Apps stayed empty.
   - Choose "Only select repositories", and pick the fork.
   - GitHub may then ask you to "Confirm access". Use the method it offers (the code of an authenticator app worked in the
     trial).
   - A direct link opens the installation for one account:
     `https://github.com/apps/vercel/installations/new/permissions?target_id=<numeric id of the account>`. The id is the
     output of `gh api users/<owner> --jq .id` (it works for an organization too).
   - Check afterwards: the Installed GitHub Apps page in the settings of that account (or organization) lists Vercel with
     your fork only.

   Back on `vercel.com/new`, your fork is in the list: import it.
2. Name the project with the name you chose in section 2. The default that Vercel offers is the repository's name, with
   letters added when that name is taken (`building-qr-system-2xir` in the trial): do not keep it.
3. Leave everything else as Vercel detects it: the Application Preset is Vite, the Root Directory is `./`, and the Build and
   Output Settings show the **Build Command from `vercel.json`**, `node scripts/vercel-build.mjs`, and the Output
   Directory `dist`: do not override them. The Node version comes from `engines` in `package.json` (`24.x`), and the
   project's Node.js Version should say 24.x.
4. Open the Environment Variables part of the import screen and add the two database variables from section 3.2:
   `DATABASE_URL` and `DATABASE_URL_UNPOOLED`. These two are what the first deploy needs. Each row has "Environments"
   (Production and Preview, Production, Preview, or Development; the default is "Production and Preview") and a
   "Sensitive value" switch. For both variables set Environments to **Production** and switch **Sensitive value** on. This
   project builds only the production branch (`vercel.json`), so Preview has no use for them.
5. Fill in both variables first, then choose **Deploy**. Do not press it while you are still pasting: the build starts at
   once, with the variables that exist then, and a build without them is refused by the gate (below). The page that follows
   says "Congratulations! You just deployed a new project".
6. After the deploy, check three things in the project's settings:
   - Settings, Environment Variables: the checkbox **Enable access to System Environment Variables**, at the foot of the
     page, is ticked (it is by default). The deploy gate reads Vercel's own variables and refuses to deploy without them.
   - The production branch of the project is the repository's default branch, `master`. Vercel sets it on import: confirm
     it, and leave it.
   - The Node.js Version says 24.x.

**What the build log should say.** Open the deployment, **Build Logs**, and search for `Deploy gate:`. On a first deploy
you should see, in this order (the exact text is in `scripts/vercel-build.mjs` and `server/productionMigrate.js`):

```
Deploy gate: migrate (a production build of a commit built by the Vercel Git integration, ...). VERCEL_ENV=production VERCEL_GIT_COMMIT_REF=master commit=<7 characters>
Production branch: master (the default branch on GitHub)
Production migration target: <the start of the Neon host>****.<rest of the host>
Database is not marked yet: it is marked production after the migration
Migration 001_init.sql: verified against GitHub master
Database marked production
Applied: 001_init.sql, 002_hardening.sql, ...
```

There is one `verified against GitHub master` line for each file in `db/migrations/` (12 in the trial install). Then open
`https://<your-domain>/api/health`: it answers `"ok":true` and the `commit`. Open `https://<your-domain>/`: you should
see the service providers' app (it has no building name yet). Both opened with no Vercel sign-in in the trial: Vercel's
default Deployment Protection did not block the production domain, so normally you need do nothing. If either of them
does ask you to sign in to Vercel, the production domain is behind Deployment Protection: turn it off for production in
Settings, Deployment Protection, because people who are not on your Vercel team must reach it.

**If the gate refuses.** The build exits with 1 and the deployment fails. A failure before the database step touches
nothing, and on a first deploy nothing was serving anyway. Each message, and what to do, is in
[deploy-and-rollback.md](runbooks/deploy-and-rollback.md) ("How a merge reaches production", "A build of another branch",
"A failed migration"). The usual ones: the environment is unknown (tick the system-variables checkbox, step 6), a database
variable is missing or `DATABASE_URL_UNPOOLED` is a pooled host (fix the variable, **Redeploy**), and the default branch
could not be read from GitHub (a private repository would need the token of section 4).

### 3.4 Google: the sign-in

You need the address of your Vercel project from section 3.3: the origin must be exactly the address people open.

1. In the [Google Cloud console](https://console.cloud.google.com/apis/credentials) choose or create a project, and set
   up the consent screen (an external app, a name, a support address). The side menu says "OAuth consent screen", and the
   pages belong to "Google Auth Platform". The trial used an existing project whose consent screen was already set up, so
   setting it up in a new project is not checked **(check in the trial install)**.
2. While the app is in Testing mode, only the Google accounts you add as **test users** can sign in: add the address of
   every committee member. Or publish the app **(check in the trial install)**.
3. Choose Create credentials, **OAuth client ID**. It opens "Google Auth Platform", Clients, Create client. Set:
   - **Application type:** Web application. Give it a name of your own.
   - **Authorised JavaScript origins** ("Authorized" in a US English console): choose "+ Add URI" and add the address of
     your site, `https://<your-domain>`: the origin only, no path and no trailing slash. Add `http://localhost:3000` only
     if you will also run the app on your computer. A note on the page says that the origin's domain is added to the
     consent screen's "authorised domains" by itself.
   - **Authorised redirect URIs:** leave it empty. No redirect address is needed (the app uses the JavaScript callback of
     Google's button, `src/admin/LoginScreen.jsx`).
   - The checkbox "Use this client for an AI-powered agent": leave it off.
4. The "OAuth client created" dialog shows the **Client ID** and a **Client secret**, and says that you will no longer be
   able to view the secret afterwards. Copy the Client ID: it is public (it is in the code that every browser loads) and is
   the value of `GOOGLE_CLIENT_ID`. **The app does not use the client secret: do not copy it, and do not store it
   anywhere.**

Google warns that a change "may take five minutes to a few hours" to reach the sign-in. In the trial the button worked at
once. If it does not work right after you added the origin, wait and try again.

### 3.5 The other variables, and the second deploy

In the project's Settings, Environment Variables, add the variables below. The two database variables already exist from
the import screen (Production, Sensitive): do not add them again. Choose "Add Environment Variable". The form has a
**Type**, and each variable below says which one it takes:

- **Secret:** the value cannot be revealed after saving (it is what [secrets.md](runbooks/secrets.md) and the import
  screen's "Sensitive value" call Sensitive).
- **Config:** the value can be read later.

The Environments default to **Production**: keep it. "Add new variable" adds one more row of the same type, so add the
Secrets together and the Configs together.

| Variable | Type | Needed? | Where the value comes from, and what it is for |
|---|---|---|---|
| `DATABASE_URL` | Secret | Yes | The pooled Neon string. What the running app connects with. Already set on the import screen |
| `DATABASE_URL_UNPOOLED` | Secret | Yes | The direct Neon string. Only the production build uses it, to migrate and to mark the database. Its host must not contain `-pooler`. Already set on the import screen |
| `GOOGLE_CLIENT_ID` | Config | Yes | Section 3.4. Without it the committee sign-in says that Google is not set up |
| `APP_BASE_URL` | Config | Yes | `https://<your-domain>`, no trailing slash. The address printed inside new QR codes. Without it the app uses the address of the request, and the committee app warns when a QR code points at a local address |
| `FIRST_ADMIN_EMAIL` | Secret | Yes, until the first sign-in | The Google e-mail of the first committee member. Section 3.6. Personal data: remove it afterwards |
| `CRON_SECRET` | Secret | Yes | A long random value that you make: `openssl rand -hex 32` in Git Bash, or the random-password generator of your password manager (64 characters, no spaces or line breaks). Vercel Cron sends it to the daily jobs. Without it every daily job refuses with a 401: nothing is deleted and the retention job never runs. The trial install did not add it **(check in the trial install)** |
| `MIGRATION_GITHUB_TOKEN` | Secret | Only if the repository is private (possible, not supported: section 4) | Section 4. It must be there **before** the first deploy |
| `HEALTH_HEARTBEAT_URL` | Secret | Optional | Section 3.9 |

After you save, Vercel shows "A new deployment is needed for changes to take effect", with a **Redeploy** button. Choose
it (or Deployments, the newest production deployment, its menu, Redeploy): a new value reaches only the deployments that
are built after it is set. The Redeploy dialog has "Choose Environment: Production" and the current deployment, and "Use
existing Build Cache", which stays off. On this second deploy the log says `Database marker: production` and
`Database is up to date.`

Check that the daily jobs can run: Settings, Cron Jobs, run `retention` once. Its log has a line that starts with
`retention:` followed by counts ([secrets.md](runbooks/secrets.md), `CRON_SECRET`) **(check in the trial install)**.

### 3.6 The first sign-in

1. Open `https://<your-domain>/admin`. The sign-in screen shows Google's button ("Sign in as" and your name). Sign in with
   Google, with exactly the address in `FIRST_ADMIN_EMAIL`. While the committee list is empty, the first sign-in with that
   address (the one Google marks as verified) adds that person as the first member, and writes it to the audit log
   (`server/firstAdmin.js`): the audit log of the Committee tab shows the member added by the system, then the sign-in.
2. **Now delete `FIRST_ADMIN_EMAIL` in Vercel and redeploy.** It is personal data and has nothing left to do. Do not leave
   it "in case". In Settings, Environment Variables, the menu of its row has Edit, Rotate, Copy to Clipboard, View History
   and Delete. Delete asks "Delete Environment Variable" and warns "You can't undo this action". Vercel then says "Removed
   Environment Variable successfully. A new deployment is needed", with Redeploy.
3. Add the other committee members in the Committee tab ("ועד"), by their Gmail address. If the consent screen is in
   Testing mode, add them as Google test users as well.

**If the sign-in does not work.** A wrong address, a Google account that is not the one in the variable, or a variable
that the running deployment does not have yet, all refuse the sign-in like any stranger's. Check the variable and
**Redeploy**. If Google itself refuses ("access blocked", an origin mismatch), the cause is in section 3.4. If you need
to add the first member another way, use the recovery command. It writes to the database in `DATABASE_URL`, so give it
the **direct** string of your production database at a prompt, never inside the command, in a clone of your repository
after `npm ci`:

```bash
( printf 'Connection string: '; read -rs DATABASE_URL; echo; export DATABASE_URL; npm run db:create-admin -- you@gmail.com "Your Name" )
```

```powershell
try { $env:DATABASE_URL = [System.Net.NetworkCredential]::new('', (Read-Host -AsSecureString 'Connection string')).Password; npm run db:create-admin -- you@gmail.com "Your Name" } finally { Remove-Item Env:DATABASE_URL -ErrorAction SilentlyContinue }
```

It prints which database it writes to, with the middle of the host hidden: check that it is yours and that the marker does
not say `nonprod`.

### 3.7 In the app: the building, a point, a provider, a test scan

1. Committee tab ("ועד"), the card ("פרטי הבניין"): fill ("שם הבניין") and ("כתובת הבניין"), and save ("שמירה"). The toast
   says that the details were saved ("פרטי הבניין נשמרו"). The committee app's brand and window title follow at once, and
   the providers' app shows the name within about a minute. The label of the installed app on a phone's Home Screen is
   fixed when the app is built, so it does not follow the name.
2. Points tab ("נקודות"), ("נקודה חדשה"): a name and a pin on the map. Every point checks the phone's location against
   its pin, so a point cannot be saved without one. For a first test, stand where the sign will hang and press the form's
   own location button ("המיקום שלי כעת") to put the pin where you stand, or click the map. Save ("שמירה"): the QR
   dialog opens by itself, and a toast says that the point was created and that its QR can be printed. The address under
   the code must be your production address, `https://<your-domain>/scan?code=BQR-...`. A banner about a local address
   means `APP_BASE_URL` is missing. The dialog has ("הדפסת שלט") (prints the sign), ("הורדה") (downloads it),
   ("העתקת קישור") (copies the link) and a button that replaces the point's code. You can open the dialog again later
   with the QR icon on the point's tile.
3. Providers tab (("ספקים") in the navigation, ("נותני שירות") as the page title), ("נותן שירות חדש"): a company and a worker
   name. **The form fills in a password by itself**: ("יצירה") makes another one, and a copy button sits next to it. Copy
   the password with that button before you save, and give it to the worker once. **Do not click outside the dialog while
   you fill it in**: it closes, and what you typed is lost.

   You do not need the demo account for a first scan: **a point with no providers assigned accepts every provider.** Once
   you assign providers to a point, only they may scan it. The switch ("חשבון דמו") makes a demo account, which may scan
   at every point, and whose scans are flagged and left out of reports and of the agent's data: use it for tests that
   must stay out of the real history.
4. On a phone, scan the sign with the camera (the QR on your computer's screen works as well as a printed sign): the
   providers' app opens, choose the name, enter the password, and the check-in is recorded (allow the location when the
   phone asks, and be within the point's radius of the pin). In the History tab ("היסטוריה") of the committee app the scan
   appears, with the point's name, the time, and the company and the worker.
5. Before you give signs to the providers: read [privacy.md](privacy.md) (in a copy, "the owner of the project" is you,
   and the periods are constants in `server/config.js`; this guide is not legal advice), and do the quick pass of the
   [iOS checklist](manual-ios-checklist.md) on a real iPhone (items 1, 4 and 8 are the quick pass).

### 3.8 GitHub settings for the copy

Do these in order. After step 5 every change to the default branch needs a pull request.

1. **Enable Actions.** In your repository open the Actions tab and choose the button "I understand my workflows, go ahead
   and enable them" (it may need a second click). The tab then says "Actions Enabled." and lists CI, Claude agent, Claude
   review, Release, Smoke test and Scorecard. Scorecard shows "Disabled" in a fork, because the scheduled workflows of a
   fork stay off: leave it, enable it, or delete the file (step 3).
2. **The smoke test** (`.github/workflows/smoke.yml`) checks every production deployment from the outside, and opens an
   issue when it fails. Make a key in the committee app: Agent tab ("אייג׳נט"), ("מפתח חדש"), named "smoke test"
   (it is shown once). Then run these three commands, in this order, with your own owner and repository name. Name the
   repository in every `gh` command of this guide (`--repo <owner>/<repo>`), so that no command can go to another
   repository, such as the one that your fork came from.

   ```bash
   gh api --method PUT repos/<owner>/<repo>/environments/smoke
   gh variable set SMOKE_BASE_URL --env smoke --body https://<your-domain> --repo <owner>/<repo>
   gh secret set SMOKE_AGENT_KEY --repo <owner>/<repo>
   ```

   The first creates the environment `smoke` (the same as Settings, Environments, New environment). It must come first:
   `gh variable set --env smoke` does not create the environment, and answers with HTTP 404 when it does not exist. (Vercel's
   deployments make an environment of their own in the repository, "Production": leave it.) The second sets the address that
   the key is sent to. The third asks for the key at a prompt: paste it there, then check that `gh secret list --repo
   <owner>/<repo>` names `SMOKE_AGENT_KEY`. The trial install did not set this secret **(check in the trial install)**.
   Without it the database step of the smoke test is skipped with a warning, and the run still passes (the trial's run did
   exactly that). [deploy-and-rollback.md](runbooks/deploy-and-rollback.md) explains each step of the smoke test.
3. **One commit straight to the default branch, before the rulesets** (a clone of your repository, `git push`):
   - `.github/CODEOWNERS`: replace `@MatanBaruch1988` with `@<your-login>`. Left as it is, it names a person who has no
     access to your repository, and the approval ruleset can never be satisfied.
   - `SECURITY.md`: put your repository's address (`https://github.com/<owner>/<repo>/security/advisories/new`) in place
     of this repository's, and say who answers. Turn on private vulnerability reporting in Settings, Code security
     **(check in the trial install)**.
   - The workflows you do not want. `claude.yml` and `claude-review.yml` (the agent loop, [ADR 0006](adr/0006-the-agent-loop-in-github-actions.md))
     start only when the sender is the literal login `MatanBaruch1988`, so in a copy they never run: their jobs are
     skipped. You may delete both files, or leave them. To run an agent loop of your own you would change that login and
     set up its secret and app, as the header of `claude.yml` explains: that is a separate decision, not part of the
     install. `release.yml` runs only by hand and a copy can ignore it. `scorecard.yml` reports the repository's security
     habits and may be deleted. Keep `ci.yml` and `smoke.yml`.

   This push starts the checks and a production deployment, which is also the first run of the smoke test. In the trial,
   Vercel (Hobby) deployed this push to the repository of a free organization, and the smoke test ran after it and passed.
4. **Wait for the checks.** In the Actions tab, on that push, the four checks must be green: `guards`, `unit`,
   `e2e (android-chrome)` and `e2e (iphone-webkit)`. In the trial they took about 23 seconds, 3 minutes, 3.5 minutes and
   5 minutes. If they did not start, run `gh workflow run ci.yml --repo <owner>/<repo>`. The smoke test should show its
   three steps as `ok`. A required check that has never run blocks every pull request, which is why the rulesets wait for
   this step.
5. **Apply the two rulesets,** from the root of a clone, with your own owner and repository name in the address
   ([`.github/rulesets/README.md`](../.github/rulesets/README.md) explains them):

   ```bash
   gh api --method POST repos/<owner>/<repo>/rulesets --input .github/rulesets/master-gates.json
   gh api --method POST repos/<owner>/<repo>/rulesets --input .github/rulesets/master-approval.json
   ```

   Both were created, and showed as "active", in a free organization's public repository in the trial. `master-gates`
   protects the default branch for everybody: a pull request, squash merge only, and the four checks green and up to date.
   `master-approval` adds one approval from a code owner (a second person). With one maintainer nobody else can approve,
   but the repository admin role may bypass it on a pull request, so you can still merge your own; applying only
   `master-gates` is also valid for a one-person copy. From now on a pull request needs a title in the Conventional Commit
   form (`chore: ...`), which the `guards` check enforces.

   If your repository is owned by a GitHub organization (not a personal account), you may also apply
   `master-merge-queue.json`: every pull request then merges through GitHub's merge queue, which runs the four checks on
   top of the newest default branch, so nobody updates a pull request by hand. A pull request joins the queue only with
   every requirement met, and GitHub does not count a bypass there. So with `master-approval` a second person must
   approve every pull request: if you are the only maintainer and merge with your bypass of it, nothing could merge (this
   repository tried it, see [`.github/rulesets/README.md`](../.github/rulesets/README.md)). A one-person copy that
   applies only `master-gates` requires no approval, so it can use the queue **(check in the trial install)**. GitHub
   offers the queue only to organizations.
6. **Dependabot.** In Settings, Code security, turn on Dependabot alerts and Dependabot security updates **(check in the
   trial install)**. `.github/dependabot.yml` asks for weekly version updates; whether they start in a fork without further
   settings is also **(check in the trial install)**. Each Dependabot pull request goes through the same four checks and
   your merge, and each merge is a production deployment.

### 3.9 Optional

The trial install did not check anything in this section **(check in the trial install)**.

**The server's heartbeat (healthchecks.io).** The server pings its own check on the first error of each day and once a day
with a summary of the last 24 hours (`server/alerts.js`, `server/summary.js`). Without it the server sends nothing.

1. In healthchecks.io make a check (a name of your own), with a period of 1 day and a grace time of 3 hours, as
   [incident.md](runbooks/incident.md) describes. Copy its ping address.
2. In Vercel add `HEALTH_HEARTBEAT_URL` for the **Production** environment only, with the Type Secret, with that address
   (an `https:` address, with no user name or password in it), and redeploy.
3. Check it: Settings, Cron Jobs, run `daily-summary` once. Its log line ends with `heartbeat=sent`, and the check shows a ping
   from just now ([secrets.md](runbooks/secrets.md), `HEALTH_HEARTBEAT_URL`).

**An uptime monitor.** Any monitor that asks `https://<your-domain>/api/health` every 5 minutes and expects the text
`"ok":true`, and another on the home page. It sees only that the site answers, not the database or a failing route
([incident.md](runbooks/incident.md), "UptimeRobot: what it sees and what it does not").

**Backups.** Neon restores only to the last 6 hours on the free plan. The command
`npm run db:backup -- --out <dir> --neon-project <project id>` makes a dump on a computer that you choose, and a
scheduled task runs it daily; the newest 30 dumps are kept. It runs on Windows or Linux only, needs the PostgreSQL 18
client tools (`pg_dump`, `pg_restore`) and the Neon CLI signed in, and the dumps hold personal data: keep them off GitHub
and off any folder that a service synchronises to the internet. Choose the computer, and the person who looks at its
`backup.log`, before you set it up. Everything (the Task Scheduler and cron lines, how to check a dump, how to restore
one) is in [restore.md](runbooks/restore.md), "Daily backups". The command needs the `production` marker that your first
deploy wrote. Without a backup your safety net is Neon's 6 hours.

**The agent API.** The committee's AI agent reads the data through a read-only API ([agent-api.md](agent-api.md)).
In the Agent tab ("אייג׳נט") make a key (shown once; keep it in the vault of the agent platform, never in a chat).
[agent-prompt.md](agent-prompt.md) has ready texts. Fill in its "Two values to fill in": `<your-domain>` (the host only,
no `https://`) and `<first day of data>` (the day your database started operating, as DD/MM/YYYY). Its section 1 also holds
the first committee's own choices: the Sunday to Friday 18:00 schedule, the yom tov rules, the report format and the
first-person wording. Edit those to your committee's wishes.

## 4. Path B: the Vercel Deploy button

The quick path: Vercel clones this repository into a new repository of yours and creates the project in one flow. It is
possible, but it is not checked on every release (section 1), and the trial install did not try it **(check in the trial
install)**. It does not make a GitHub fork: **the copy is not linked to this repository, so updates are manual**
(section 5).

1. Settle the address and the project name (section 2), make the Google client (section 3.4) and the Neon strings
   (section 3.2, by hand), and have the first member's e-mail and a `CRON_SECRET` ready (section 3.5).
2. Open this address, after you replace `my-building-qr` (twice) with your name. Vercel documents these parameters:
   `repository-url`, `project-name`, `repository-name`, `env`, `envDescription` and `envLink`.

   ```
   https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2Fbuilding-attendance%2Fbuilding-qr-system&project-name=my-building-qr&repository-name=my-building-qr&env=DATABASE_URL,DATABASE_URL_UNPOOLED,GOOGLE_CLIENT_ID,APP_BASE_URL,FIRST_ADMIN_EMAIL,CRON_SECRET&envDescription=Neon%20connection%20strings%2C%20Google%20client%20id%2C%20your%20site%20address%2C%20first%20committee%20e-mail%2C%20random%20cron%20secret&envLink=https%3A%2F%2Fgithub.com%2Fbuilding-attendance%2Fbuilding-qr-system%2Fblob%2Fmaster%2Fdocs%2Finstall.md
   ```

   Vercel asks you to connect your GitHub account, name the new repository, and fill in the six variables (it cannot be
   given values in the address). Section 3.5 says what each one is, and the same rule holds as on the import screen of
   section 3.3: fill in all of them first, then deploy. How this form treats Environments and Sensitive is not checked: after
   the first deploy, open Settings, Environment Variables and make sure the two database variables are for Production only
   and are Secrets **(check in the trial install)**.
3. **Neon through the button.** Vercel can also create the database in the same flow, with the `stores` parameter. Remove
   `DATABASE_URL,DATABASE_URL_UNPOOLED,` from `env` and add this to the end of the address
   **(check in the trial install)**: the two slugs are a guess from Neon's name on the Marketplace, and the safe choice is
   the address above.

   ```
   &stores=%5B%7B%22type%22%3A%22integration%22%2C%22integrationSlug%22%3A%22neon%22%2C%22productSlug%22%3A%22neon%22%2C%22protocol%22%3A%22storage%22%7D%5D
   ```
4. **A private repository needs a token before the first deploy.** Vercel's flow may create the new repository as private
   by default **(check in the trial install)**. The deploy gate then cannot read the default branch or the migration
   files from GitHub, and the first build fails with `HTTP 404` or `HTTP 401` after about a minute
   ([deploy-and-rollback.md](runbooks/deploy-and-rollback.md)). Make the repository public in the Vercel flow, which is the
   supported choice. A private repository works only with a token added as `MIGRATION_GITHUB_TOKEN` (Production,
   Secret) and a **Redeploy**: a fine-grained token for that one repository, with read access to its contents
   **(check in the trial install)**. That is possible, not checked on every release, and not a supported setup. Nothing is
   touched by the failed build.
5. From the first deploy on, follow path A: "What the build log should say" in section 3.3, then section 3.5 (the
   variables are already set, so only check that the two database ones are for Production and are Secrets, and check the
   daily jobs), then 3.6 to 3.9. A new repository (not a fork) should have its Actions on from the start
   **(check in the trial install)**, so a failed first deploy opens an issue titled "Production deployment failed for ...":
   close it by hand when a later deployment succeeds.

## 5. Updating a copy

A copy updates by releases: update to each new release, in order. The latest release is the supported version, and every
security fix is released as a PATCH version on the day it merges, so a PATCH can be a security fix: take it soon. An update
is a merge to the production branch, and every such merge is a production deployment (unless it changes only documents,
tests or CI: [`scripts/vercel-ignore.mjs`](../scripts/vercel-ignore.mjs) skips those). The migrations run in that build by
themselves ([ADR 0002](adr/0002-production-migrations-in-the-vercel-build.md)): there is nothing to run by hand.

1. **Hear about releases.** Watch this repository's releases on GitHub (Watch, Custom, Releases)
   **(check in the trial install)**.
2. **Read the notes of the release.** Releases are tags (`v2.1.0`) with notes: [releases.md](releases.md) explains the
   numbers. A MAJOR version always has something you must do (a new variable, a Google or Vercel setting, a command),
   written in the section "What installers must do". A MINOR or PATCH version asks nothing of you, but read its notes all
   the same.
3. **Bring the release in.** The release, not the newest commit of `master`, is what you update to.
   - **Path A (a fork): a pull request from a branch of your own copy.** `<version>` below is the number without the "v",
     for example `2.1.0`. You need no clone.

     1. Make a branch in your copy at the commit of the release's tag. A fork shares this repository's objects, so the
        commit is already there:

        ```bash
        gh api repos/building-attendance/building-qr-system/commits/v<version> --jq .sha
        gh api -X POST repos/<owner>/<repo>/git/refs -f ref=refs/heads/update-<version> -f sha=<the commit that the first command printed>
        ```
     2. Open a pull request from `update-<version>` into `master`, titled `chore: update to v<version>`: on GitHub
        (Pull requests, New pull request), or
        `gh pr create --repo <owner>/<repo> --base master --head update-<version> --title "chore: update to v<version>" --body "Update to v<version>."`.
        GitHub says that the branch is behind `master`: that is expected, because the branch has none of your own commits.
     3. Choose **Update branch** on the pull request (or `gh pr update-branch <number> --repo <owner>/<repo>`). It
        merges your copy's own commits (the `CODEOWNERS` and `SECURITY.md` edits of section 3.8, step 3, and any others)
        into the branch, so that the branch is the release plus your changes. If GitHub reports a conflict, a file that
        you changed is also a file that the release changed: resolve it in a clone of your repository (`git fetch origin`,
        `git switch update-<version>`, `git merge origin/master`, fix the files, `git push`) **(check in the trial
        install)**. Keep your own changes small (section 3.8, step 3) so that this is rare.
     4. Wait for the four checks (about 5 minutes in the trial).
     5. **Squash merge** the pull request. When `master-approval` is on and you are the only maintainer, the merge needs
        the checkbox "Merge without waiting for requirements to be met" (the administrator's bypass of section 3.8,
        step 5).
     6. Vercel deploys the merge (step 4), and `https://<your-domain>/api/health` shows the new commit.

     Afterwards GitHub shows your copy as "N ahead, N behind" this repository, although the content matches. That is
     expected: a squash merge makes a new commit and breaks the shared history. Leave it, and do not "fix" it. The next
     update goes the same way **(check in the trial install)**: the trial did only one update, so a second update after a
     squash is not checked.

     **Do not use "Sync fork" on your repository's page.** With the rulesets of section 3.8 on, it is refused: in the
     trial the page said "1 commit ahead of, 1 commit behind", "Update branch" did nothing visible, and the API answered
     "Repository rule violations found" (HTTP 422). **Never press "Discard N commits"** there: it deletes your copy's own
     commits. Do not open the pull request the other way round either, with this repository's `master` as its head
     (Pull requests, New, compare across forks): once your copy has commits of its own, that pull request can never merge.
     It stays behind `master` (the rulesets want the head up to date with `master`, and you cannot update the other
     repository's branch), and it gets a failing "Vercel" check, which is not a required one.
   - **Path B (not a fork):** the route above does not work, because a Deploy-button copy does not share this repository's
     objects. Use a clone: `git remote add upstream https://github.com/building-attendance/building-qr-system.git`
     (if `git remote -v` does not list it already), `git fetch --all --tags`, `git switch -c update-<version>
     origin/master`, `git merge <the tag of the release, for example v2.1.0>`, `git push -u origin update-<version>`, and
     open a pull request titled `chore: update to v<version>`. The checks run, and you merge it. The history of a
     Deploy-button copy may not be related to this repository's: then `git merge` stops with "refusing to merge unrelated
     histories", and you need `--allow-unrelated-histories` and a careful read of every conflict
     **(check in the trial install)**.
4. **Watch the deploy.** The build log has the `Deploy gate:` line, and then `Applied: ...` with the new migrations. If a
   migration fails, the previous deployment keeps serving: [deploy-and-rollback.md](runbooks/deploy-and-rollback.md), "A failed
   migration". The smoke test then checks the live site.
5. **Phones keep working.** An installed app updates only when the person next opens it, so old apps call the API for days or
   weeks. That is why every change is made in three steps in separate releases (expand, migrate, contract: `AGENTS.md`,
   "Database and API changes"), and old clients are accepted until a later release removes what they used. You need to do
   nothing for this.
6. **Which version am I on?** Both apps show their build id (the first 7 characters of the commit) at the foot of the home
   screen and of the Committee tab, and `/api/health` shows it as `commit`. On this repository, `git fetch --tags` and
   `git tag --contains <build id> --sort=version:refname | head -1` name the first release that has it
   ([releases.md](releases.md)). In your copy that does not work: the build id is a commit of your own repository, it has
   commits of its own (section 3.8, step 3), and every update is a squash merge, so no release of this repository
   contains that commit. Read the version from the title of the last merged update pull request instead,
   `chore: update to v<version>` (`gh pr list --repo <owner>/<repo> --state merged --search "chore: update to"`).

## 6. When something breaks

Start with [something-broke.md](runbooks/something-broke.md): four steps for the person who is not a programmer. Then:

- [incident.md](runbooks/incident.md): the checklist, and where the app wrote down what went wrong.
- [deploy-and-rollback.md](runbooks/deploy-and-rollback.md): how a deploy works, the gate's messages, Instant Rollback, a failed
  migration.
- [restore.md](runbooks/restore.md): damaged or lost data. Neon's window is 6 hours, so do not wait.
- [secrets.md](runbooks/secrets.md): where each secret lives, and how to rotate one that leaked.

The runbooks were written for the first installation and say "the owner" for the person who looks at Vercel, Neon and
healthchecks.io: in your copy that is your maintainer, or whoever your committee names for each service. Where a runbook
mentions a service or a dated record of the first installation, it says so, and says what a copy does instead.

## 7. Checklist: what you created, and where it lives

Names only. Never write a value into a file of the repository, an issue, a pull request or a chat. In Vercel, "Secret" is
the Type of a variable whose value cannot be revealed after saving ([secrets.md](runbooks/secrets.md) and the import screen
call it Sensitive); "Config" is one that can be read.

| What | Made in | Lives in |
|---|---|---|
| The fork (or the cloned repository) | GitHub | GitHub: your account or organization |
| `.github/CODEOWNERS` with your login, `SECURITY.md` with your address | Your repository | The repository |
| The two rulesets (`master-gates`, `master-approval`) | `gh api` | GitHub, Settings, Rules |
| Neon project (Postgres 18, AWS US East 1) | Neon | Neon |
| `DATABASE_URL` (pooled), `DATABASE_URL_UNPOOLED` (direct) | Neon | Vercel, Production, Secret. A copy in your password manager |
| Google Cloud project, consent screen, OAuth client | Google Cloud console | Google. Its origin is your address. The client secret is not used and is stored nowhere |
| `GOOGLE_CLIENT_ID` | Google | Vercel, Production, Config. Public value |
| `APP_BASE_URL` | You | Vercel, Production, Config |
| `CRON_SECRET` | Your computer or password manager | Vercel, Production, Secret. Nowhere else |
| `FIRST_ADMIN_EMAIL` | You | Vercel, Production, Secret, only until the first sign-in: remove it |
| `MIGRATION_GITHUB_TOKEN` | GitHub, only if the repository is private (not supported) | Vercel, Production, Secret |
| The Vercel project, its name and its address | Vercel | Vercel |
| Vercel's GitHub app, on the account that owns the fork | GitHub and Vercel | GitHub: the account's Installed GitHub Apps |
| The environment `smoke`, with the variable `SMOKE_BASE_URL` | GitHub, `gh api` and `gh variable set` | GitHub, Settings, Environments |
| The agent key "smoke test", and the secret `SMOKE_AGENT_KEY` | The committee app, `gh secret set` | The key: the committee app (it can be revoked there). The secret: GitHub Actions |
| `HEALTH_HEARTBEAT_URL` (optional) | healthchecks.io | Vercel, Production, Secret |
| The agent key of the committee's agent (optional) | The committee app, Agent tab | The vault of the agent platform |
| `BACKUP_HEARTBEAT_URL`, or `BACKUP_DATABASE_URL` (optional) | healthchecks.io, Neon | The environment of the backup computer only |
| The backup folder (optional) | The backup computer | That computer, never synchronised online |
| The building's name and address | The committee app, Committee tab | The database |
