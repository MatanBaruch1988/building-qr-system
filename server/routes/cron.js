import { route } from '../router.js'
import { runRetention } from '../retention.js'

// Scheduled jobs. Vercel Cron calls each of them with an HTTP GET and `Authorization: Bearer <CRON_SECRET>` (the `crons`
// entry in vercel.json). The router checks that secret before this handler runs (requireCron in server/auth.js, chosen by
// the `/cron/` rule of server/access.js): a request without it, or on a deployment that has no CRON_SECRET, never gets here.

// The daily retention job (server/retention.js, docs/privacy.md). The answer and the log line hold the three counts and
// nothing else, so the runtime log (read by more people than the committee) learns nothing about a person.
route('GET', '/cron/retention', async () => {
  const { sessions, loginAttempts, deviceLabels } = await runRetention()
  console.log(`retention: sessions=${sessions} login_attempts=${loginAttempts} device_labels=${deviceLabels}`)
  return { ok: true, sessions, login_attempts: loginAttempts, device_labels: deviceLabels }
})
