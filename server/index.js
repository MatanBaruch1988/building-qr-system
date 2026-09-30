// Importing the route files registers them with the router.
import './routes/provider.js'
import './routes/admin.js'
import './routes/agent.js'
import { route } from './router.js'

route('GET', '/health', async () => ({ ok: true }))

export { handle } from './router.js'
