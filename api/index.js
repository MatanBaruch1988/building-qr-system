// One Vercel function serves the whole API (keeps us far below the per-plan function limit).
//
// vercel.json rewrites every /api/* request to this file and passes the original path as ?__path=
// (a catch-all file name such as api/[...path].js only matched a single path segment, so /api/admin/config 404ed).
import { handle } from '../server/index.js'

export default function handler(req, res) {
  const url = new URL(req.url, 'http://local')
  const rest = url.searchParams.get('__path')
  if (rest !== null) {
    url.searchParams.delete('__path')
    const query = url.searchParams.toString()
    req.url = `/api/${rest}${query ? `?${query}` : ''}` // the original address, as the router expects it
  }
  return handle(req, res)
}
