/**
 * Shared formatting utilities
 */

export const formatTime = (date) => {
  if (!date) return '-'
  const d = date instanceof Date ? date : new Date(date)
  return d.toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit' })
}

export const formatDate = (date) => {
  if (!date) return '-'
  const d = date instanceof Date ? date : new Date(date)
  return d.toLocaleDateString('he-IL', { day: 'numeric', month: 'short' })
}

export const formatFullDate = (date) => {
  if (!date) return ''
  const d = date instanceof Date ? date : new Date(date)
  return d.toLocaleDateString('he-IL', { day: 'numeric', month: 'long', year: 'numeric' })
}

export const getDisplayWorkerName = (worker) => {
  if (!worker) return '?'
  return worker.company || worker.name || '?'
}

export const getWorkerInitials = (text) => {
  if (!text) return '?'
  const parts = text.split(' ')
  if (parts.length >= 2) {
    return parts[0][0] + parts[1][0]
  }
  return text.substring(0, 2)
}

/**
 * Get display name for a scan record by looking up the worker
 */
export const getScanWorkerDisplayName = (scan, workers = []) => {
  if (workers.length > 0 && scan.workerId) {
    const w = workers.find(w => w.id === scan.workerId)
    if (w) return w.company || w.name
  }
  return scan.workerName
}

/**
 * Get assigned worker names for a location, with fallback for old format
 */
export const getLocationAssignedNames = (location, workers = []) => {
  if (location.assignedWorkerNames?.length > 0) {
    return location.assignedWorkerNames.join(', ')
  }
  if (location.assignedWorkerId && workers.length > 0) {
    const w = workers.find(w => w.id === location.assignedWorkerId)
    return w ? (w.company || w.name) : (location.assignedWorkerName || '-')
  }
  return null
}
