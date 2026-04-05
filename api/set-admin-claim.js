import { authAdmin } from './_lib/firebase-admin.js'
import { verifyAdmin } from './_lib/auth.js'

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })
  if (!await verifyAdmin(req)) return res.status(403).json({ error: 'Admin access required' })

  const { targetUid } = req.body
  if (!targetUid) return res.status(400).json({ error: 'Missing targetUid' })

  await authAdmin.setCustomUserClaims(targetUid, { admin: true })
  res.status(200).json({ success: true })
}
