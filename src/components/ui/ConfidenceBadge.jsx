import React from 'react'
import { getConfidenceDisplay, CONFIDENCE_LEVELS } from '../../utils/distance'

function ConfidenceBadge({ confidence }) {
  if (!confidence) return null

  const display = getConfidenceDisplay(confidence)

  const bgColor = confidence === CONFIDENCE_LEVELS.HIGH
    ? 'rgba(52, 199, 89, 0.12)'
    : confidence === CONFIDENCE_LEVELS.MEDIUM
      ? 'rgba(255, 149, 0, 0.12)'
      : 'rgba(255, 204, 0, 0.15)'

  const textColor = confidence === CONFIDENCE_LEVELS.HIGH
    ? '#248A3D'
    : confidence === CONFIDENCE_LEVELS.MEDIUM
      ? '#C93400'
      : '#8B7500'

  return (
    <span className="confidence-badge" style={{
      display: 'inline-flex',
      alignItems: 'center',
      gap: '3px',
      padding: '3px 8px',
      borderRadius: '100px',
      fontSize: '0.75rem',
      fontWeight: '600',
      background: bgColor,
      color: textColor
    }}>
      {display.icon} {display.label}
    </span>
  )
}

export default ConfidenceBadge
