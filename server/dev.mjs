// Local API server for development: same handler as production, mounted on plain node:http.
// Vite proxies /api here (see vite.config.js). Reads DATABASE_URL from .env.local.
import http from 'node:http'
import { loadEnv } from './loadEnv.js'

loadEnv()

// `node server/dev.mjs --schema=dev_ui` runs against a scratch schema (see scripts/dev-seed.mjs).
const schemaArg = process.argv.find((a) => a.startsWith('--schema='))
if (schemaArg) {
  process.env.DB_SCHEMA = schemaArg.slice('--schema='.length)
  process.env.DEV_ADMIN_LOGIN ??= '1' // scratch mode = local development: enable the dev-only admin shortcut
}
if (process.env.DB_SCHEMA) console.log(`Using scratch schema "${process.env.DB_SCHEMA}"`)

// Refuse to start on a production database (the scratch schema, if any, lives in the same database).
const { getPool } = await import('./db.js')
const { assertNotProduction } = await import('./dbGuard.js')
try {
  await assertNotProduction(getPool())
} catch (err) {
  console.error(err.message)
  process.exit(1)
}

const { handle } = await import('./index.js')
const port = Number(process.env.API_PORT || 3001)

http
  .createServer((req, res) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      const type = String(req.headers['content-type'] || '')
      if (raw && type.startsWith('application/json')) {
        try {
          req.body = JSON.parse(raw)
        } catch {
          res.statusCode = 400
          res.setHeader('Content-Type', 'application/json')
          return res.end(JSON.stringify({ error: { code: 'invalid_json', message: 'Invalid JSON' } }))
        }
      }
      handle(req, res)
    })
  })
  .listen(port, () => console.log(`API listening on http://localhost:${port}`))
