// Runs before every test file (vitest.config.js, `setupFiles`). The committee app keeps the last answer of each of its loads in memory for
// the life of the page (src/admin/loadCache.js), so that a tab that is opened again draws it at once. A test stands for one page load, and
// a page load starts with nothing in that cache: so after every test the cache is emptied, and the next test cannot draw what an earlier
// one was shown. (tests/components/load-cache.test.jsx tests the cache itself, inside one test.) The module has no imports, so a test of
// the server in plain node pays nothing for this.
import { afterEach } from 'vitest'
import { clearLoadCache } from '../src/admin/loadCache.js'

afterEach(() => {
  clearLoadCache()
})
