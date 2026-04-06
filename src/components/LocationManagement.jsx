import React from 'react'
import { EditButton, DeleteButton } from './ui/IconButton'
import { getLocationAssignedNames } from '../utils/formatters'
import { printAllQRCodes } from '../utils/qrGenerator'
import Modal from './ui/Modal'

function LocationManagement({
  locations,
  workers,
  onAddLocation,
  onEditLocation,
  onDeleteLocation,
  selectedLocation,
  onSelectLocation,
  qrCodeDataUrl
}) {
  return (
    <>
      <div className="card location-list-card">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '15px' }}>
          <h2>נקודות QR</h2>
          <div style={{ display: 'flex', gap: '8px' }}>
            {locations.length > 0 && (
              <button className="btn btn-secondary" onClick={() => printAllQRCodes(locations)}>
                🖨️ הדפס הכל
              </button>
            )}
            <button className="btn btn-primary" onClick={onAddLocation}>
              + הוסף נקודה
            </button>
          </div>
        </div>

        {locations.length === 0 ? (
          <div className="empty-state">
            <div className="empty-state-icon">📍</div>
            <p>אין נקודות עדיין</p>
            <p>הוסף נקודה חדשה להתחיל</p>
          </div>
        ) : (
          <div className="location-list">
            {locations.map(location => {
              const assignedNames = getLocationAssignedNames(location, workers)
              return (
                <div
                  key={location.id}
                  className="list-item"
                  style={{
                    cursor: 'pointer',
                    background: selectedLocation?.id === location.id ? 'rgba(0,122,255,0.15)' : undefined,
                    borderColor: selectedLocation?.id === location.id ? 'rgba(0,122,255,0.4)' : undefined
                  }}
                  onClick={() => onSelectLocation(location)}
                >
                  <div className="list-item-content">
                    <h4>{location.name}</h4>
                    <p>{location.description || 'ללא תיאור'}</p>
                    <p style={{ fontSize: '0.8rem' }}>
                      רדיוס: {location.radiusMeters} מטר
                      {assignedNames && (
                        <span> • משויך ל: {assignedNames}</span>
                      )}
                    </p>
                  </div>
                  <div className="list-item-actions">
                    <EditButton
                      onClick={() => onEditLocation(location)}
                      stopPropagation
                    />
                    <DeleteButton
                      onClick={() => onDeleteLocation(location.id)}
                      stopPropagation
                    />
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>

      {/* QR Floating Modal */}
      <Modal
        show={!!selectedLocation && !!qrCodeDataUrl}
        onClose={() => onSelectLocation(null)}
        title={selectedLocation?.name || ''}
      >
        <div className="qr-display">
          <img src={qrCodeDataUrl} alt="QR Code" />
          {selectedLocation?.description && (
            <p style={{ marginTop: '12px', fontSize: '0.9rem', color: 'var(--text-secondary)' }}>
              {selectedLocation.description}
            </p>
          )}
          <p style={{ marginTop: '10px', fontSize: '0.85rem', color: 'var(--text-tertiary)', fontFamily: 'monospace', direction: 'ltr' }}>
            {selectedLocation?.latitude?.toFixed(5)}, {selectedLocation?.longitude?.toFixed(5)}
          </p>
        </div>
      </Modal>
    </>
  )
}

export default LocationManagement
