// One Vercel function serves the whole API (keeps us far below the per-plan function limit).
import { handle } from '../server/index.js'

export default handle
