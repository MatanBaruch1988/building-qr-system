// The committee reads the audit log: GET /api/admin/audit (ADR 0007, decision 4). Read only: nothing here writes a row.
//
// The router guards it before this handler runs (server/access.js: every /admin/ route is the committee's), so no one
// without a committee session reaches the query. The agent API has no route to it, on purpose (docs/privacy.md).
//
// The query, the filters, the cursor and the shape of an entry are in server/auditRead.js (see its header); this file is only the
// route, and re-exports what the tests of the log import from here.
import { route } from '../router.js'
import { listAudit } from '../auditRead.js'

export { auditQuery, listAudit, AUDIT_GROUPS, AUDIT_FILTERS } from '../auditRead.js'

route('GET', '/admin/audit', ({ query: q }) => listAudit(q))
