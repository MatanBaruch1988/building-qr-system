// One-time helper for the cutover: exports every Firestore collection of the OLD app to JSON files
// (read-only: nothing is written to Firestore). Feed the result to `npm run db:import-firestore`.
// Usage: npm run db:export-firestore -- <output-dir>
// Needs FIREBASE_SERVICE_ACCOUNT_KEY in .env.local. Remove this script (and firebase-admin) after the cutover.
import fs from 'node:fs'
import path from 'node:path'
import { loadEnv } from '../server/loadEnv.js'
loadEnv()

const outDir = process.argv[2]
if (!outDir) {
  console.error('Usage: npm run db:export-firestore -- <output-dir>')
  process.exit(1)
}

const raw = process.env.FIREBASE_SERVICE_ACCOUNT_KEY
if (!raw) throw new Error('FIREBASE_SERVICE_ACCOUNT_KEY is missing from .env.local')
let creds
try {
  creds = JSON.parse(raw)
} catch {
  creds = JSON.parse(raw.replace(/\\"/g, '"').replace(/\\\\n/g, '\\n'))
}

const { default: admin } = await import('firebase-admin')
admin.initializeApp({ credential: admin.credential.cert(creds) })
const db = admin.firestore()

// Timestamps become {__ts: ISO} (what importFirestore reads).
const plain = (v) => {
  if (v && typeof v.toDate === 'function') return { __ts: v.toDate().toISOString() }
  if (Array.isArray(v)) return v.map(plain)
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, plain(x)]))
  return v
}

fs.mkdirSync(outDir, { recursive: true })
const counts = {}
for (const col of await db.listCollections()) {
  const snap = await col.get()
  const docs = snap.docs.map((d) => ({ id: d.id, ...plain(d.data()) }))
  fs.writeFileSync(path.join(outDir, `${col.id}.json`), JSON.stringify(docs, null, 2), 'utf8')
  counts[col.id] = docs.length
}
console.log('Exported:', JSON.stringify(counts))
process.exit(0)
