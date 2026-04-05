import { db } from './_lib/firebase-admin.js'
import { verifyAuth } from './_lib/auth.js'

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' })

  const decoded = await verifyAuth(req)
  if (!decoded) return res.status(401).json({ error: 'Authentication required' })

  const workers = await db.collection('workers').get()
  const list = workers.docs.map(doc => ({
    id: doc.id,
    name: doc.data().name || '',
    company: doc.data().company || '',
    isActive: doc.data().isActive !== false
  }))

  res.status(200).json(list)
}
