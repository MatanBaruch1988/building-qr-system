import crypto from 'crypto'
import { db, authAdmin } from './_lib/firebase-admin.js'
import { verifyAuth } from './_lib/auth.js'

const pinAttempts = new Map()
const RATE_LIMIT_MAX = 5
const RATE_LIMIT_WINDOW_MS = 10 * 60 * 1000

function checkRateLimit(ip) {
  const now = Date.now()
  const entry = pinAttempts.get(ip)
  if (!entry || now > entry.resetTime) {
    pinAttempts.set(ip, { count: 1, resetTime: now + RATE_LIMIT_WINDOW_MS })
    return true
  }
  entry.count++
  return entry.count <= RATE_LIMIT_MAX
}

function hashPin(pin) {
  return crypto.createHash('sha256').update(String(pin)).digest('hex')
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  const decoded = await verifyAuth(req)
  if (!decoded) return res.status(401).json({ error: 'Authentication required' })

  const { workerId, pin } = req.body
  if (!workerId || !pin) return res.status(400).json({ error: 'Missing workerId or pin' })

  const ip = req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown'
  if (!checkRateLimit(ip)) {
    return res.status(429).json({ error: 'Too many attempts. Try again later.' })
  }

  const workerDoc = await db.collection('workers').doc(workerId).get()
  if (!workerDoc.exists) return res.status(401).json({ error: 'Invalid credentials' })

  const worker = workerDoc.data()
  const hashedInput = hashPin(pin)
  if (hashedInput !== worker.pinHash) return res.status(401).json({ error: 'Invalid credentials' })

  const customToken = await authAdmin.createCustomToken(decoded.uid, {
    workerId,
    workerName: worker.company || worker.name || ''
  })

  res.status(200).json({
    token: customToken,
    workerName: worker.company || worker.name || '',
    workerId
  })
}
