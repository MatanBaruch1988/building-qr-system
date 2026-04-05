import { useState, useEffect } from 'react'
import { db, functions, auth } from '../services/firebase'
import { collection, onSnapshot } from 'firebase/firestore'
import { httpsCallable } from 'firebase/functions'
import { signInAnonymously } from 'firebase/auth'
import { cacheLocations, getCachedLocations, cacheWorkers, getCachedWorkers } from '../services/dataCache'
import { isOnline } from '../services/offlineStorage'

export function useLocations() {
  const [locations, setLocations] = useState(() => getCachedLocations())

  useEffect(() => {
    let unsub = null

    function startListener() {
      // Don't start if already listening
      if (unsub) return

      unsub = onSnapshot(
        collection(db, 'locations'),
        (snapshot) => {
          const data = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }))
          setLocations(data)
          cacheLocations(data)
        },
        (error) => {
          console.error('Locations listener error:', error)
          // Firestore SDK handles reconnection automatically,
          // but if fatal, clean up
          unsub = null
        }
      )
    }

    // Always try to start - Firestore SDK queues if offline
    startListener()

    // Listen for reconnection to restart if listener died
    const handleOnline = () => {
      if (!unsub) startListener()
    }
    window.addEventListener('online', handleOnline)

    return () => {
      if (unsub) unsub()
      window.removeEventListener('online', handleOnline)
    }
  }, [])

  return locations
}

export function useWorkers() {
  const [workers, setWorkers] = useState(() => getCachedWorkers())

  useEffect(() => {
    let unsub = null

    function startListener() {
      if (unsub) return

      unsub = onSnapshot(
        collection(db, 'workers'),
        (snapshot) => {
          const data = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }))
          setWorkers(data)
          cacheWorkers(data)
        },
        (error) => {
          console.error('Workers listener error:', error)
          unsub = null
        }
      )
    }

    // Always try to start - Firestore SDK queues if offline
    startListener()

    const handleOnline = () => {
      if (!unsub) startListener()
    }
    window.addEventListener('online', handleOnline)

    return () => {
      if (unsub) unsub()
      window.removeEventListener('online', handleOnline)
    }
  }, [])

  return workers
}

export function usePublicWorkerList() {
  const [workers, setWorkers] = useState(() => getCachedWorkers())
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    async function fetchWorkers() {
      try {
        // Ensure anonymous auth session exists before calling authenticated Cloud Function.
        // This is needed because workers must see the list BEFORE entering their PIN.
        // Only sign in anonymously if no user is currently authenticated,
        // to avoid destroying an existing custom token session.
        if (!auth.currentUser) {
          await signInAnonymously(auth)
        }

        const getList = httpsCallable(functions, 'getWorkerList')
        const result = await getList()
        setWorkers(result.data)
        cacheWorkers(result.data)
      } catch (error) {
        console.error('Error fetching worker list:', error)
        // Keep using cached data
      } finally {
        setLoading(false)
      }
    }

    if (isOnline()) {
      fetchWorkers()
    } else {
      setLoading(false)
    }

    const handleOnline = () => fetchWorkers()
    window.addEventListener('online', handleOnline)
    return () => window.removeEventListener('online', handleOnline)
  }, [])

  return { workers, loading }
}
