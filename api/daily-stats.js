import { db } from './_lib/firebase-admin.js'
import { verifyAdmin } from './_lib/auth.js'

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' })
  if (!await verifyAdmin(req)) return res.status(403).json({ error: 'Admin access required' })

  const today = new Date()
  today.setHours(0, 0, 0, 0)

  const scansCreatedAt = await db.collection('scans').where('createdAt', '>=', today).get()
  const scansTimestamp = await db.collection('scans').where('timestamp', '>=', today).get()

  const uniqueDocs = new Map()
  scansCreatedAt.docs.forEach(doc => uniqueDocs.set(doc.id, doc))
  scansTimestamp.docs.forEach(doc => uniqueDocs.set(doc.id, doc))

  const allDocs = Array.from(uniqueDocs.values())
  const stats = { total: allDocs.length, valid: 0, invalid: 0, byLocation: {}, byWorker: {} }

  allDocs.forEach(doc => {
    const scan = doc.data()
    scan.isValid ? stats.valid++ : stats.invalid++
    if (scan.locationName) stats.byLocation[scan.locationName] = (stats.byLocation[scan.locationName] || 0) + 1
    if (scan.workerName) stats.byWorker[scan.workerName] = (stats.byWorker[scan.workerName] || 0) + 1
  })

  res.status(200).json(stats)
}
