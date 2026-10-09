// @vitest-environment jsdom
// What looks like a secret is decided in one place, shared/secretLike.js, which the server can use too. The committee's audit log
// screen still finds `looksSecret` where it always has (src/admin/auditDescribe.js), and it must be that very function, not a copy
// (the cases of the function itself are in tests/read-filters.test.js, and what the screen leaves out in audit-log.test.jsx).
import { describe, it, expect } from 'vitest'
import { looksSecret } from '../../shared/secretLike.js'
import { looksSecret as looksSecretOnTheScreen } from '../../src/admin/auditDescribe.js'

describe('looksSecret on the audit log screen', () => {
  it('is the function of shared/secretLike.js', () => {
    expect(looksSecretOnTheScreen).toBe(looksSecret)
  })
})
