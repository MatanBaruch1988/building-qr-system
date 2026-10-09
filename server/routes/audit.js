// The committee reads the audit log: GET /api/admin/audit (ADR 0007, decision 4). Read only: nothing here writes a row.
//
// The router guards it before this handler runs (server/access.js: every /admin/ route is the committee's), so no one
// without a committee session reaches the query. The committee's agent reads the same log through GET /api/agent/v1/audit
// (server/routes/agent.js), which shows each detail only through the allow-list of its action (owner decision of 08/10/2026,
// AGENTS.md "Safety", docs/privacy.md).
//
// The query, the filters, the cursor and the shape of an entry are in server/auditRead.js (see its header); this file is only the
// route, and re-exports what the tests of the log import from here.
import { route } from '../router.js'
import { listAudit } from '../auditRead.js'

export { auditQuery, listAudit, AUDIT_GROUPS, AUDIT_FILTERS } from '../auditRead.js'

route('GET', '/admin/audit', ({ query: q }) => listAudit(q))
