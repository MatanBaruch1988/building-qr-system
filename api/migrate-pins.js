import crypto from 'crypto'
import { db, admin } from './_lib/firebase-admin.js'
import { verifyAdmin } from './_lib/auth.js'

function hashPin(pin) {
  return crypto.createHash('sha256').update(String(pin)).digest('hex')
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })
  if (!await verifyAdmin(req)) return res.status(403).json({ error: 'Admin access required' })

  const workers = await db.collection('workers').get()
  const toMigrate = workers.docs.filter(doc => {
    const w = doc.data()
    return w.code && !w.pinHash
  })

  let migrated = 0
  const BATCH_LIMIT = 500

  for (let i = 0; i < toMigrate.length; i += BATCH_LIMIT) {
    const chunk = toMigrate.slice(i, i + BATCH_LIMIT)
    const batch = db.batch()
    chunk.forEach(doc => {
      const pinHash = hashPin(doc.data().code)
      batch.update(doc.ref, { pinHash, code: admin.firestore.FieldValue.delete() })
    })
    await batch.commit()
    migrated += chunk.length
  }

  res.status(200).json({ success: true, migrated })
}
