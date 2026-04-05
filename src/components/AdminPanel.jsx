import React, { useState, useEffect } from 'react'
import { db, functions } from '../services/firebase'
import { collection, addDoc, deleteDoc, doc, updateDoc, serverTimestamp } from 'firebase/firestore'
import { httpsCallable } from 'firebase/functions'
import { generateQRCodeString, generateQRCodeDataURL } from '../utils/qrGenerator'
import { getCurrentPosition, isGeolocationAvailable } from '../services/geolocation'
import { GEOFENCE_CONFIG } from '../utils/distance'
import Modal from './ui/Modal'
import LocationManagement from './LocationManagement'
import WorkerManagement from './WorkerManagement'
import LocationForm from './LocationForm'
import WorkerForm from './WorkerForm'

function AdminPanel({ locations, workers }) {
  const [activeTab, setActiveTab] = useState('locations')
  const [showLocationModal, setShowLocationModal] = useState(false)
  const [showWorkerModal, setShowWorkerModal] = useState(false)
  const [editingLocation, setEditingLocation] = useState(null)
  const [editingWorker, setEditingWorker] = useState(null)
  const [selectedLocation, setSelectedLocation] = useState(null)
  const [qrCodeDataUrl, setQrCodeDataUrl] = useState(null)
  const [gettingLocation, setGettingLocation] = useState(false)

  const emptyLocationForm = {
    name: '',
    description: '',
    latitude: 32.0853,
    longitude: 34.7818,
    radiusMeters: GEOFENCE_CONFIG.DEFAULT_RADIUS,
    assignedWorkerIds: [],
    assignedWorkerNames: []
  }

  const emptyWorkerForm = {
    name: '',
    code: '',
    company: ''
  }

  const [locationForm, setLocationForm] = useState(emptyLocationForm)
  const [workerForm, setWorkerForm] = useState(emptyWorkerForm)
  const [loading, setLoading] = useState(false)
  const [message, setMessage] = useState(null)

  // Auto-dismiss messages after 5 seconds
  useEffect(() => {
    if (message) {
      const timer = setTimeout(() => setMessage(null), 5000)
      return () => clearTimeout(timer)
    }
  }, [message])

  // Generate QR code when location is selected
  useEffect(() => {
    if (selectedLocation?.qrCode) {
      generateQRCodeDataURL(selectedLocation.qrCode)
        .then(setQrCodeDataUrl)
        .catch(console.error)
    } else {
      setQrCodeDataUrl(null)
    }
  }, [selectedLocation])

  // קבל מיקום נוכחי כשנפתח המודל להוספת נקודה חדשה
  useEffect(() => {
    if (showLocationModal && !editingLocation && isGeolocationAvailable()) {
      setGettingLocation(true)
      getCurrentPosition()
        .then(position => {
          setLocationForm(prev => ({
            ...prev,
            latitude: position.latitude,
            longitude: position.longitude
          }))
        })
        .catch(err => console.log('Could not get current location:', err))
        .finally(() => setGettingLocation(false))
    }
  }, [showLocationModal])

  // --- פתיחת מודלים ---

  const openAddLocation = () => {
    setEditingLocation(null)
    setLocationForm(emptyLocationForm)
    setShowLocationModal(true)
  }

  const openEditLocation = (location) => {
    setEditingLocation(location)
    setLocationForm({
      name: location.name || '',
      description: location.description || '',
      latitude: location.latitude || 32.0853,
      longitude: location.longitude || 34.7818,
      radiusMeters: location.radiusMeters || GEOFENCE_CONFIG.DEFAULT_RADIUS,
      assignedWorkerIds: location.assignedWorkerIds || (location.assignedWorkerId ? [location.assignedWorkerId] : []),
      assignedWorkerNames: location.assignedWorkerNames || (location.assignedWorkerName ? [location.assignedWorkerName] : [])
    })
    setShowLocationModal(true)
  }

  const openAddWorker = () => {
    setEditingWorker(null)
    setWorkerForm(emptyWorkerForm)
    setShowWorkerModal(true)
  }

  const openEditWorker = (worker) => {
    setEditingWorker(worker)
    setWorkerForm({
      name: worker.name || '',
      code: worker.code || '',
      company: worker.company || ''
    })
    setShowWorkerModal(true)
  }

  // --- שמירת נקודה ---

  const handleSaveLocation = async (e) => {
    e.preventDefault()
    setLoading(true)
    setMessage(null)

    try {
      if (editingLocation) {
        await updateDoc(doc(db, 'locations', editingLocation.id), {
          ...locationForm,
          assignedWorkerId: '',
          assignedWorkerName: ''
        })
        setMessage({ type: 'success', text: 'הנקודה עודכנה בהצלחה!' })
        if (selectedLocation?.id === editingLocation.id) {
          setSelectedLocation({ ...selectedLocation, ...locationForm })
        }
      } else {
        const qrCode = generateQRCodeString(Date.now().toString())
        await addDoc(collection(db, 'locations'), {
          ...locationForm,
          assignedWorkerId: '',
          assignedWorkerName: '',
          qrCode,
          isActive: true,
          createdAt: serverTimestamp()
        })
        setMessage({ type: 'success', text: 'הנקודה נוספה בהצלחה!' })
      }

      setLocationForm(emptyLocationForm)
      setShowLocationModal(false)
      setEditingLocation(null)
    } catch (error) {
      console.error('Error saving location:', error)
      setMessage({ type: 'error', text: editingLocation ? 'שגיאה בעדכון נקודה' : 'שגיאה בהוספת נקודה' })
    }

    setLoading(false)
  }

  const handleDeleteLocation = async (locationId) => {
    if (!window.confirm('האם למחוק את הנקודה?')) return
    try {
      await deleteDoc(doc(db, 'locations', locationId))
      setMessage({ type: 'success', text: 'הנקודה נמחקה' })
      if (selectedLocation?.id === locationId) setSelectedLocation(null)
    } catch (error) {
      console.error('Error deleting location:', error)
      setMessage({ type: 'error', text: 'שגיאה במחיקת נקודה' })
    }
  }

  // --- שמירת נותן שירות ---

  const handleSaveWorker = async (e) => {
    e.preventDefault()
    setLoading(true)
    setMessage(null)

    try {
      // Extract PIN separately - never write it directly to Firestore
      const { code: pin, ...safeWorkerData } = workerForm

      if (editingWorker) {
        await updateDoc(doc(db, 'workers', editingWorker.id), { ...safeWorkerData })
        // Hash the PIN server-side if code was provided
        if (pin) {
          const hashPIN = httpsCallable(functions, 'hashWorkerPIN')
          await hashPIN({ workerId: editingWorker.id, pin })
        }
        setMessage({ type: 'success', text: 'נותן השירות עודכן בהצלחה!' })
      } else {
        const docRef = await addDoc(collection(db, 'workers'), {
          ...safeWorkerData,
          isActive: true,
          createdAt: serverTimestamp()
        })
        // Hash the PIN server-side (also deletes any plaintext code field)
        const hashPIN = httpsCallable(functions, 'hashWorkerPIN')
        await hashPIN({ workerId: docRef.id, pin })
        setMessage({ type: 'success', text: 'נותן השירות נוסף בהצלחה!' })
      }

      setWorkerForm(emptyWorkerForm)
      setShowWorkerModal(false)
      setEditingWorker(null)
    } catch (error) {
      console.error('Error saving worker:', error)
      setMessage({ type: 'error', text: editingWorker ? 'שגיאה בעדכון נותן שירות' : 'שגיאה בהוספת נותן שירות' })
    }

    setLoading(false)
  }

  const handleDeleteWorker = async (workerId) => {
    if (!window.confirm('האם למחוק את נותן השירות?')) return
    try {
      await deleteDoc(doc(db, 'workers', workerId))
      setMessage({ type: 'success', text: 'נותן השירות נמחק' })
    } catch (error) {
      console.error('Error deleting worker:', error)
      setMessage({ type: 'error', text: 'שגיאה במחיקת נותן שירות' })
    }
  }

  const handleMapClick = (latlng) => {
    setLocationForm(prev => ({ ...prev, latitude: latlng.lat, longitude: latlng.lng }))
  }

  const handleGetCurrentLocation = async () => {
    if (!isGeolocationAvailable()) {
      alert('הדפדפן לא תומך במיקום')
      return
    }
    setGettingLocation(true)
    try {
      const position = await getCurrentPosition()
      setLocationForm(prev => ({ ...prev, latitude: position.latitude, longitude: position.longitude }))
    } catch (err) {
      alert('לא ניתן לקבל מיקום: ' + err.message)
    }
    setGettingLocation(false)
  }

  const closeLocationModal = () => { setShowLocationModal(false); setEditingLocation(null) }
  const closeWorkerModal = () => { setShowWorkerModal(false); setEditingWorker(null) }

  return (
    <div>
      {message && (
        <div role="alert" className={`card ${message.type === 'success' ? 'badge-success' : 'badge-danger'}`}
             style={{ marginBottom: '20px', padding: '15px' }}>
          {message.text}
        </div>
      )}

      <div className="nav" style={{ marginBottom: '20px' }}>
        <button
          className={`nav-btn ${activeTab === 'locations' ? 'active' : ''}`}
          onClick={() => setActiveTab('locations')}
        >
          נקודות QR ({locations.length})
        </button>
        <button
          className={`nav-btn ${activeTab === 'workers' ? 'active' : ''}`}
          onClick={() => setActiveTab('workers')}
        >
          נותני שירות ({workers.length})
        </button>
      </div>

      {activeTab === 'locations' && (
        <LocationManagement
          locations={locations}
          workers={workers}
          onAddLocation={openAddLocation}
          onEditLocation={openEditLocation}
          onDeleteLocation={handleDeleteLocation}
          selectedLocation={selectedLocation}
          onSelectLocation={setSelectedLocation}
          qrCodeDataUrl={qrCodeDataUrl}
        />
      )}

      {activeTab === 'workers' && (
        <WorkerManagement
          workers={workers}
          onAddWorker={openAddWorker}
          onEditWorker={openEditWorker}
          onDeleteWorker={handleDeleteWorker}
        />
      )}

      {/* Location Modal */}
      <Modal
        show={showLocationModal}
        onClose={closeLocationModal}
        title={editingLocation ? 'ערוך נקודת QR' : 'הוסף נקודת QR חדשה'}
        footer={
          <>
            <button type="button" className="btn btn-secondary" onClick={closeLocationModal}>ביטול</button>
            <button type="submit" form="location-form" className="btn btn-primary" disabled={loading}>
              {loading ? <span className="spinner"></span> : (editingLocation ? 'שמור שינויים' : 'הוסף נקודה')}
            </button>
          </>
        }
      >
        <form id="location-form" onSubmit={handleSaveLocation}>
          <LocationForm
            form={locationForm}
            onChange={setLocationForm}
            workers={workers}
            onMapClick={handleMapClick}
            gettingLocation={gettingLocation}
            onGetCurrentLocation={handleGetCurrentLocation}
          />
        </form>
      </Modal>

      {/* Worker Modal */}
      <Modal
        show={showWorkerModal}
        onClose={closeWorkerModal}
        title={editingWorker ? 'ערוך נותן שירות' : 'הוסף נותן שירות חדש'}
        footer={
          <>
            <button type="button" className="btn btn-secondary" onClick={closeWorkerModal}>ביטול</button>
            <button type="submit" form="worker-form" className="btn btn-primary" disabled={loading}>
              {loading ? <span className="spinner"></span> : (editingWorker ? 'שמור שינויים' : 'הוסף נותן שירות')}
            </button>
          </>
        }
      >
        <form id="worker-form" onSubmit={handleSaveWorker}>
          <WorkerForm form={workerForm} onChange={setWorkerForm} />
        </form>
      </Modal>
    </div>
  )
}

export default AdminPanel
