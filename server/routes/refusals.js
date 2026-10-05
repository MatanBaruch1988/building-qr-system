import { route } from '../router.js'
import { requireAdmin } from '../auth.js'
import { listRefusals } from '../scanRefusals.js'

// The visits that the server refused (a point that was switched off or never assigned, a code that names no point, ...), for the
// committee. They are recorded by server/scanRefusals.js, and they are not scans: they never count as attendance. The router
// has run the guard of the committee (server/access.js) before this handler, and the guard remembers its answer.
route('GET', '/admin/scan-refusals', async ({ req, query: q }) => {
  await requireAdmin(req)
  return listRefusals(q)
})
