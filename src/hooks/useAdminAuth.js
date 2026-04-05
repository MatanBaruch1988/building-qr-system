import { useState, useEffect } from 'react'
import { auth, googleProvider } from '../services/firebase'
import { signInWithPopup, signOut, onAuthStateChanged } from 'firebase/auth'

export function useAdminAuth() {
  const [user, setUser] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  // Listen to auth state changes
  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, async (firebaseUser) => {
      if (firebaseUser) {
        try {
          // Force token refresh to get latest claims
          const tokenResult = await firebaseUser.getIdTokenResult(true)
          if (tokenResult.claims.admin === true) {
            setUser(firebaseUser)
            setError(null)
          } else {
            // Not an admin - sign out
            signOut(auth)
            setUser(null)
            setError('המשתמש אינו מורשה לגשת לממשק הניהול')
          }
        } catch (err) {
          console.error('Error refreshing token:', err)
          setUser(null)
          setError('שגיאת רשת - לא ניתן לאמת הרשאות. נסה שוב.')
        }
      } else {
        setUser(null)
      }
      setLoading(false)
    })

    return () => unsubscribe()
  }, [])

  // Google Sign-In
  const login = async () => {
    setError(null)
    setLoading(true)
    try {
      await signInWithPopup(auth, googleProvider)
      // Claim check happens in onAuthStateChanged
    } catch (err) {
      if (err.code === 'auth/popup-closed-by-user') {
        setError('ההתחברות בוטלה')
      } else if (err.code === 'auth/popup-blocked') {
        setError('חלון ההתחברות נחסם. אנא אפשר חלונות קופצים')
      } else {
        setError('שגיאה בהתחברות: ' + err.message)
      }
      setLoading(false)
    }
  }

  // Sign out
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
