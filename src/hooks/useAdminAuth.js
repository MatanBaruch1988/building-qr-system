import { useState, useEffect } from 'react'
import { auth, googleProvider } from '../services/firebase'
import { signInWithPopup, signInWithRedirect, getRedirectResult, signOut, onAuthStateChanged } from 'firebase/auth'

export function useAdminAuth() {
  const [user, setUser] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  // Handle redirect result on mount (called after Google redirects back)
  useEffect(() => {
    getRedirectResult(auth)
      .catch((err) => {
        if (err.code !== 'auth/no-auth-event') {
          setError('שגיאה בהתחברות: ' + err.message)
          setLoading(false)
        }
      })
  }, [])

  // Listen to auth state changes
  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, async (firebaseUser) => {
      if (firebaseUser) {
        try {
          let tokenResult = await firebaseUser.getIdTokenResult(false)
          if (!tokenResult.claims.admin) {
            tokenResult = await firebaseUser.getIdTokenResult(true)
          }
          if (tokenResult.claims.admin === true) {
            setUser(firebaseUser)
            setError(null)
          } else {
            signOut(auth)
            setUser(null)
            setError('המשתמש אינו מורשה לגשת לממשק הניהול')
          }
        } catch (err) {
          setUser(null)
          setError('שגיאת רשת — לא ניתן לאמת הרשאות. בדוק חיבור ונסה שוב.')
        }
      } else {
        setUser(null)
      }
      setLoading(false)
    })

    return () => unsubscribe()
  }, [])

  // Google Sign-In — popup with redirect fallback if blocked
  const login = async () => {
    setError(null)
    setLoading(true)
    try {
      await signInWithPopup(auth, googleProvider)
    } catch (err) {
      if (err.code === 'auth/popup-closed-by-user' || err.code === 'auth/cancelled-popup-request') {
        setError('ההתחברות בוטלה')
      } else if (err.code === 'auth/popup-blocked') {
        try {
          await signInWithRedirect(auth, googleProvider)
        } catch (redirectErr) {
          setError('שגיאה בהתחברות: ' + redirectErr.message)
        }
      } else {
        setError('שגיאה בהתחברות: ' + err.message)
      }
      setLoading(false)
    }
  }

  const logout = async () => {
    try {
      await signOut(auth)
      setUser(null)
    } catch (err) {
      console.error('Logout error:', err)
    }
  }

  return {
    user,
    loading,
    error,
    login,
    logout,
    isAuthenticated: !!user
  }
}
