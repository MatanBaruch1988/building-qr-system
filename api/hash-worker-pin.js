import crypto from 'crypto'
import { db, admin } from './_lib/firebase-admin.js'
import { verifyAdmin } from './_lib/auth.js'

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })
  if (!await verifyAdmin(req)) return res.status(403).json({ error: 'Admin access required' })

  const { workerId, pin } = req.body
  if (!workerId || !pin) return res.status(400).json({ error: 'Missing workerId or pin' })

  const pinHash = crypto.createHash('sha256').update(String(pin)).digest('hex')
  await db.collection('workers').doc(workerId).update({
    pinHash,
    code: admin.firestore.FieldValue.delete()
  })

  res.status(200).json({ success: true })
}
