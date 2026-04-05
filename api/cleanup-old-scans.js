import { db } from './_lib/firebase-admin.js'

export default async function handler(req, res) {
  // Verify cron secret to prevent unauthorized access
  if (req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' })
  }

  const cutoffDate = new Date()
  cutoffDate.setMonth(cutoffDate.getMonth() - 6)

  const oldScansCreatedAt = await db.collection('scans').where('createdAt', '<', cutoffDate).limit(250).get()
  const oldScansTimestamp = await db.collection('scans').where('timestamp', '<', cutoffDate).limit(250).get()

  const docsToDelete = new Map()
  oldScansCreatedAt.docs.forEach(doc => docsToDelete.set(doc.id, doc.ref))
  oldScansTimestamp.docs.forEach(doc => docsToDelete.set(doc.id, doc.ref))

  if (docsToDelete.size === 0) return res.status(200).json({ deleted: 0 })

  const batch = db.batch()
  docsToDelete.forEach(ref => batch.delete(ref))
  await batch.commit()

  res.status(200).json({ deleted: docsToDelete.size })
}
