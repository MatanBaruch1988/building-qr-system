import { useState, useEffect, useCallback } from 'react'
import { auth, functions } from '../services/firebase'
import {
  signInAnonymously,
  signInWithCustomToken,
  onAuthStateChanged,
  signOut
} from 'firebase/auth'
import { httpsCallable } from 'firebase/functions'

export function useWorkerAuth() {
  const [worker, setWorker] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  // Restore worker info from localStorage on mount
  // and listen to Firebase Auth state
  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (user) => {
      if (user && user.isAnonymous === false) {
        // User has a custom token session - restore worker info from localStorage
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
        // If localStorage still has worker info but auth user is null,
        // the custom token session has expired (1-hour lifetime).
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
      // Step 1: Sign in anonymously to get a Firebase Auth session
      await signInAnonymously(auth)

      // Step 2: Call Cloud Function to validate PIN and get custom token
      const validatePIN = httpsCallable(functions, 'validateWorkerPIN')
      const result = await validatePIN({ workerId, pin })

      // Step 3: Sign in with the custom token (replaces anonymous session)
      await signInWithCustomToken(auth, result.data.token)

      // Step 4: Save worker info locally
      const workerInfo = {
        id: result.data.workerId,
        name: result.data.workerName,
        company: result.data.workerName
      }
      setWorker(workerInfo)
      localStorage.setItem('currentWorker', JSON.stringify(workerInfo))

      setLoading(false)
      return workerInfo
    } catch (err) {
      setLoading(false)
      // Map Firebase error codes to Hebrew messages
      if (err.code === 'functions/unauthenticated') {
        setError('קוד שגוי')
      } else if (err.code === 'functions/resource-exhausted') {
        setError('יותר מדי ניסיונות. נסה שוב בעוד מספר דקות.')
      } else if (err.code === 'functions/not-found') {
        setError('קוד שגוי')
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
