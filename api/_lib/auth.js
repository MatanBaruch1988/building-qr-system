import { authAdmin } from './firebase-admin.js'

export async function verifyAuth(req) {
  const authHeader = req.headers.authorization
  if (!authHeader?.startsWith('Bearer ')) {
    return null
  }
  try {
    return await authAdmin.verifyIdToken(authHeader.split('Bearer ')[1])
  } catch {
    return null
  }
}

export async function verifyAdmin(req) {
  const decoded = await verifyAuth(req)
  if (!decoded || decoded.admin !== true) {
    return null
  }
  return decoded
}
