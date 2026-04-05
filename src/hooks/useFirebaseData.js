import { useState, useEffect } from 'react'
import { db, auth } from '../services/firebase'
import { collection, onSnapshot } from 'firebase/firestore'
import { signInAnonymously } from 'firebase/auth'
import { apiCall } from '../services/api'
import { cacheLocations, getCachedLocations, cacheWorkers, getCachedWorkers } from '../services/dataCache'
import { isOnline } from '../services/offlineStorage'

export function useLocations() {
  const [locations, setLocations] = useState(() => getCachedLocations())

  useEffect(() => {
    let unsub = null

    function startListener() {
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
          unsub = null
        }
      )
    }

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
        if (!auth.currentUser) {
          await signInAnonymously(auth)
        }

        const data = await apiCall('get-worker-list')
        setWorkers(data)
        cacheWorkers(data)
      } catch (error) {
        console.error('Error fetching worker list:', error)
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
