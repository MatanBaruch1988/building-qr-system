import { authAdmin } from './_lib/firebase-admin.js'

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  const secret = process.env.BOOTSTRAP_SECRET
  if (!secret || req.body.secret !== secret) return res.status(403).json({ error: 'Forbidden' })

  const { email } = req.body
  if (!email) return res.status(400).json({ error: 'Missing email' })

  try {
    const user = await authAdmin.getUserByEmail(email)
    const existing = user.customClaims
    if (existing?.admin === true) return res.status(409).json({ error: 'Already admin', uid: user.uid })

    await authAdmin.setCustomUserClaims(user.uid, { admin: true })
    res.status(200).json({ success: true, uid: user.uid, email: user.email })
  } catch (err) {
    if (err.code === 'auth/user-not-found') {
      return res.status(404).json({ error: 'User not found' })
    }
    console.error('bootstrap-admin error:', err)
    res.status(500).json({ error: err.message })
  }
}
