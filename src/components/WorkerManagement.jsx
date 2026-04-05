import React from 'react'
import { EditButton, DeleteButton } from './ui/IconButton'

function WorkerManagement({ workers, onAddWorker, onEditWorker, onDeleteWorker }) {
  return (
    <div className="card">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '15px' }}>
        <h2>נותני שירות</h2>
        <button className="btn btn-primary" onClick={onAddWorker}>
          + הוסף נותן שירות
        </button>
      </div>

      {workers.length === 0 ? (
        <div className="empty-state">
          <div className="empty-state-icon">👤</div>
          <p>אין נותני שירות עדיין</p>
          <p>הוסף נותן שירות חדש להתחיל</p>
        </div>
      ) : (
        <div className="table-container">
          <table>
            <thead>
              <tr>
                <th>משתמש</th>
                <th>קוד</th>
                <th>פעולות</th>
              </tr>
            </thead>
            <tbody>
              {workers.map(worker => (
                <tr key={worker.id}>
                  <td>{worker.company || '-'}</td>
                  <td>****</td>
                  <td>
                    <div className="list-item-actions">
                      <EditButton onClick={() => onEditWorker(worker)} />
                      <DeleteButton onClick={() => onDeleteWorker(worker.id)} />
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

export default WorkerManagement
