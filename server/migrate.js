import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const DEFAULT_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'db', 'migrations')

/** Applies db/migrations/*.sql in name order, each in its own transaction, once. Returns the names applied. */
export async function migrate(pool, dir = DEFAULT_DIR) {
  await pool.query(
    'create table if not exists schema_migrations (name text primary key, applied_at timestamptz not null default now())',
  )
  const done = new Set((await pool.query('select name from schema_migrations')).rows.map((r) => r.name))
  const applied = []
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
    if (done.has(file)) continue
    const client = await pool.connect()
    try {
      await client.query('begin')
      await client.query(fs.readFileSync(path.join(dir, file), 'utf8'))
      await client.query('insert into schema_migrations (name) values ($1)', [file])
      await client.query('commit')
      applied.push(file)
    } catch (err) {
      await client.query('rollback').catch(() => {})
      throw new Error(`Migration ${file} failed: ${err.message}`)
    } finally {
      client.release()
    }
  }
  return applied
}
