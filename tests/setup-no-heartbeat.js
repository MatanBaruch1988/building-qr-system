// Runs before every test file (vitest.config.js, `setupFiles`). The server pings healthchecks.io at the address in
// HEALTH_HEARTBEAT_URL when it has its first unexpected error of a building day (server/alerts.js, server/heartbeat.js), and no
// test may reach the network, or send an alert to the owner. That variable lives only in the Production environment of Vercel
// (docs/runbooks/secrets.md), so a test normally does not see it. This file makes sure of it anyway, for a shell or a
// `.env.local` that has it by mistake: the value is made EMPTY, which the server reads as "not set", and not deleted, because
// loadEnv (server/loadEnv.js) fills only a variable that is undefined, so a deleted one could come back from a file.
// tests/alerts.test.js sets its own fake address for the duration of a test, and sends through a fetcher that it injects.
process.env.HEALTH_HEARTBEAT_URL = ''
