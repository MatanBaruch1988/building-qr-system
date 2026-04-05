import { useState, useEffect, useCallback } from 'react'
import { auth } from '../services/firebase'
import {
  signInAnonymously,
  signInWithCustomToken,
  onAuthStateChanged,
  signOut
} from 'firebase/auth'
import { apiCall } from '../services/api'

export function useWorkerAuth() {
  const [worker, setWorker] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (user) => {
      if (user && user.isAnonymous === false) {
        const saved = localStorage.getItem('currentWorker')
        if (saved) {
          try {
            const parsed = JSON.parse(saved)
            if (parsed && parsed.id && parsed.name) {
              setWorker(parsed)
            }
          } catch {
            localStorage.removeItem('currentWorker')
          }
        }
      } else if (!user) {
        const saved = localStorage.getItem('currentWorker')
        if (saved) {
          setError('פג תוקף ההתחברות. יש להתחבר מחדש.')
          localStorage.removeItem('currentWorker')
        }
        setWorker(null)
      }
      setLoading(false)
    })

    return () => unsubscribe()
  }, [])

  const login = useCallback(async (workerId, pin) => {
    setError(null)
    setLoading(true)

    try {
      await signInAnonymously(auth)

      const result = await apiCall('validate-worker-pin', {
        method: 'POST',
        body: JSON.stringify({ workerId, pin })
      })

      await signInWithCustomToken(auth, result.token)

      const workerInfo = {
        id: result.workerId,
        name: result.workerName,
        company: result.workerName
      }
      setWorker(workerInfo)
      localStorage.setItem('currentWorker', JSON.stringify(workerInfo))

      setLoading(false)
      return workerInfo
    } catch (err) {
      setLoading(false)
      if (err.status === 401) {
        setError('קוד שגוי')
      } else if (err.status === 429) {
        setError('יותר מדי ניסיונות. נסה שוב בעוד מספר דקות.')
      } else {
        setError('שגיאה בהתחברות. נסה שוב.')
      }
      throw err
    }
  }, [])

  const logout = useCallback(async () => {
    try {
      await signOut(auth)
    } catch (err) {
      console.error('Logout error:', err)
    }
    setWorker(null)
    localStorage.removeItem('currentWorker')
  }, [])

  return { worker, loading, error, login, logout, isLoggedIn: !!worker }
}
