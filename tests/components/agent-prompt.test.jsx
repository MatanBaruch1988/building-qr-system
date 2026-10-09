// @vitest-environment jsdom
// The committee's Agent screen, in the prompt it gives to copy: the real AgentView, with the network (`api`) answered by the test. The
// prompt is the analyst prompt of src/admin/agentPrompt.js (the same text as docs/agent-prompt.md: tests/agent-prompt.test.js), with the
// address of this installation filled in, shown in full and copied in full.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, within, cleanup, fireEvent } from '@testing-library/react'
import AgentView from '../../src/admin/views/AgentView.jsx'
import { ToastProvider, ConfirmProvider } from '../../src/admin/ui.jsx'
import { clearLoadCache } from '../../src/admin/loadCache.js'
import { api } from '../../src/api/client.js'
import { agentPrompt, DOCS_BASE } from '../../src/admin/agentPrompt.js'

vi.mock('../../src/api/client.js', () => ({ api: vi.fn() }))

const WAIT = { timeout: 4000 }
const BASE = `${window.location.origin}/api/agent/v1`

function show() {
  api.mockImplementation(async (path) => {
    if (path === '/admin/api-keys') return { api_keys: [], limits: { per_minute: 60, per_day: 2000 } }
    throw new Error(`the test does not expect ${path}`)
  })
  return render(<ToastProvider><ConfirmProvider><AgentView /></ConfirmProvider></ToastProvider>)
}

/** The block of the screen that holds the prompt: the only <pre> of the "how does the agent connect" section. */
async function promptBlock() {
  const heading = await screen.findByRole('heading', { level: 2, name: /איך האייג'נט מתחבר/ }, WAIT)
  const block = heading.closest('section').querySelector('pre')
  expect(block, 'the prompt is shown in a <pre> of the how-to section').toBeTruthy()
  return block
}

beforeEach(() => {
  clearLoadCache() // every test stands for a new page load: the screen keeps its last answer in memory otherwise
})
afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  delete navigator.clipboard
})

describe('the prompt on the Agent screen', () => {
  it('is the analyst prompt, whole, with the address of this installation and no placeholder', async () => {
    show()
    const block = await promptBlock()
    expect(block.textContent).toBe(agentPrompt(BASE))
    expect(block.textContent).toContain(BASE)
    expect(block.textContent).not.toContain(DOCS_BASE)
    expect(block.textContent).not.toContain('<your-domain>')
    expect(block.textContent).toMatch(/never count rows yourself/i)
  })

  it('says the address of the API above it, the same one that the prompt carries', async () => {
    show()
    const block = await promptBlock()
    const section = block.closest('section')
    expect(within(section).getByText(BASE, { selector: 'span' })).toBeTruthy()
  })

  it('is copied whole by its button', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    show()
    const block = await promptBlock()
    fireEvent.click(within(block.closest('section')).getByRole('button', { name: 'העתקת ההנחיה' }))
    await vi.waitFor(() => expect(writeText).toHaveBeenCalledTimes(1), WAIT)
    expect(writeText).toHaveBeenCalledWith(agentPrompt(BASE))
    await screen.findByText('ההנחיה הועתקה', {}, WAIT)
  })
})
