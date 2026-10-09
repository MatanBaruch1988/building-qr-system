import { route } from '../router.js'
import { runRetention } from '../retention.js'
import { buildSummary, summaryCounts, summaryText } from '../summary.js'
import { sendHeartbeat } from '../heartbeat.js'
import { Answer } from '../http.js'
import { failureLabel } from '../logSafe.js'
import { formatDateTime } from '../../shared/datetime.js'

// Scheduled jobs. Vercel Cron calls each of them with an HTTP GET and `Authorization: Bearer <CRON_SECRET>` (the `crons`
// entries in vercel.json). The router checks that secret before this handler runs (requireCron in server/auth.js, chosen by
// the `/cron/` rule of server/access.js): a request without it, or on a deployment that has no CRON_SECRET, never gets here.

// The daily retention job (server/retention.js, docs/privacy.md). The answer and the log line hold the six counts and
// nothing else, so the runtime log (read by more people than the committee) learns nothing about a person.
route('GET', '/cron/retention', async () => {
  const { sessions, loginAttempts, deviceLabels, appErrors, alertPings, apiKeyUsage } = await runRetention()
  console.log(
    `retention: sessions=${sessions} login_attempts=${loginAttempts} device_labels=${deviceLabels} app_errors=${appErrors} alert_pings=${alertPings} api_key_usage=${apiKeyUsage}`,
  )
  return {
    ok: true,
    sessions,
    login_attempts: loginAttempts,
    device_labels: deviceLabels,
    app_errors: appErrors,
    alert_pings: alertPings,
    api_key_usage: apiKeyUsage,
  }
})

// The daily summary of the last 24 hours (server/summary.js, docs/adr/0007, step 2). It builds the summary and sends it to the
// owner's check on healthchecks.io: the base address when the hours were fine, /fail when they held a technical problem, with a
// short plain-text body either way (counts, route patterns and codes only, summaryText). The answer is awaited, because the host
// may freeze the function once it has answered, and the request is bounded (server/heartbeat.js: one try, HEARTBEAT_TIMEOUT_MS).
// Without HEALTH_HEARTBEAT_URL (every Preview deployment, every local run and every test) nothing is sent, and the answer and the
// log line are the same as with it.
//
// The answer and the log line hold the verdict, the reasons (a fixed list of words), the counts, and `heartbeat`: `sent`, or the
// one fixed word that sendHeartbeat gives when it did not (`not_configured`, `rejected`, `timeout`, ...). Never the body, the
// address, a name or a message.
//
// When the database cannot be read there is nothing to count: the check is pinged at /fail with a line that says so and the
// failure's code or name (never its message), and the answer is a complete 503 (an Answer, as GET /api/health/db gives), so that
// the router does not record it as an unhandled 500 and send a second alert for the same failure.
route('GET', '/cron/daily-summary', async () => {
  const now = new Date()
  let summary
  try {
    summary = await buildSummary({ now })
  } catch (err) {
    const label = failureLabel(err)
    console.error(`daily-summary failed: ${label}`)
    const sent = await sendHeartbeat({
      signal: 'fail',
      body: `Daily summary could not read the database, ${formatDateTime(now)}: ${label}`,
    })
    throw new Answer({ status: 503, json: { ok: false, heartbeat: sent.sent ? 'sent' : sent.reason } })
  }
  const sent = await sendHeartbeat({ signal: summary.verdict === 'fail' ? 'fail' : 'ok', body: summaryText(summary) })
  const heartbeat = sent.sent ? 'sent' : sent.reason
  const counts = summaryCounts(summary)
  console.log(
    `daily-summary: verdict=${summary.verdict} reasons=${summary.reasons.join(',') || 'none'} ` +
      `${Object.entries(counts)
        .map(([name, value]) => `${name}=${value}`)
        .join(' ')} heartbeat=${heartbeat}`,
  )
  return { ok: true, verdict: summary.verdict, reasons: summary.reasons, ...counts, heartbeat }
})
