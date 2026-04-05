/**
 * Worker permission utilities
 */

/**
 * Check if a worker is allowed to scan at a given location
 * Returns { allowed: boolean, assignedNames: string }
 */
export const checkWorkerAccess = (location, worker) => {
  const hasAssignment = (location.assignedWorkerIds?.length > 0) || location.assignedWorkerId

  if (!hasAssignment) {
    return { allowed: true, assignedNames: '' }
  }

  const isAllowed =
    location.assignedWorkerIds?.includes(worker.id) ||
    location.assignedWorkerId === worker.id

  const assignedNames = location.assignedWorkerNames?.length > 0
    ? location.assignedWorkerNames.join(', ')
    : (location.assignedWorkerName || 'נותן שירות אחר')

  return { allowed: isAllowed, assignedNames }
}
