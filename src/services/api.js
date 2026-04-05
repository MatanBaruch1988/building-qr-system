import { auth } from './firebase'

async function getAuthToken() {
  const user = auth.currentUser
  if (!user) return null
  return await user.getIdToken()
}

export async function apiCall(endpoint, options = {}) {
  const token = await getAuthToken()
  const headers = { 'Content-Type': 'application/json' }
  if (token) headers['Authorization'] = `Bearer ${token}`

  const res = await fetch(`/api/${endpoint}`, {
    ...options,
    headers: { ...headers, ...options.headers }
  })

  if (!res.ok) {
    const data = await res.json().catch(() => ({}))
    const error = new Error(data.error || `API error ${res.status}`)
    error.status = res.status
    throw error
  }

  return res.json()
}
