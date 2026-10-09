// The instructions that the committee gives to its AI agent are one text in two places, and a text that is written twice drifts:
//   - src/admin/agentPrompt.js: the prompt that the Agent screen of the committee app shows and copies, with the address of the
//     installation filled in (the screen itself is checked in tests/components/agent-prompt.test.jsx);
//   - docs/agent-prompt.md: the section "The analyst prompt", the same text with the address written as the placeholder DOCS_BASE,
//     followed by the texts that are added to it (the chief of staff, the daily run, the questions on request).
// What this test pins, and what it leaves free:
//   1. the two are equal in every character (the only free part is the address), so a change made in one place and forgotten in the
//      other fails here, naming the section that is behind;
//   2. every endpoint of the agent API (AGENT_ENDPOINTS, server/agentEndpoints.js) is named in the analyst prompt, in its copy in the
//      app and in the text for the chief of staff, and the daily run reads the endpoints it has to read;
//   3. the rules that the prompt exists to carry are there: count with /counts and never by hand, follow the cursor to the end,
//      ask for the biggest page (the numbers are checked against server/config.js, not typed again), wait Retry-After seconds on a
//      429, write dates as DD/MM/YYYY and HH:MM, keep the data and the key with the committee;
//   4. nothing in it that must not be there: no key prefix (server/config.js owns it), no limit that the server owns, no Hebrew (it is
//      for the agent, in English), no placeholder of an installation left in the copy that the app gives.
// The rest of the prose is not pinned: it can be improved without touching this file.
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { AGENT_ENDPOINTS } from '../server/agentEndpoints.js'
import {
  API_KEY_PREFIX, MAX_PAGE_SIZE, MAX_REFUSAL_PAGE_SIZE, MAX_AUDIT_PAGE_SIZE,
  AGENT_KEY_MAX_PER_MINUTE, AGENT_KEY_MAX_PER_DAY, COUNTS_MAX_DAYS, COUNTS_MAX_ROWS,
} from '../server/config.js'
import { BUILDING_TZ } from '../shared/contract.js'
import { EM_DASH } from '../scripts/text-rules.mjs'
import { agentPrompt, DOCS_BASE } from '../src/admin/agentPrompt.js'

const MD = 'docs/agent-prompt.md'
const abs = (relative) => fileURLToPath(new URL(`../${relative}`, import.meta.url))
const md = fs.readFileSync(abs(MD), 'utf8').replace(/\r\n/g, '\n')

// The Hebrew block of Unicode, built from its code points so that this file holds no Hebrew letter.
const HEBREW = new RegExp(`[${String.fromCharCode(0x0590)}-${String.fromCharCode(0x05ff)}]`)

// ---- reading the document ---------------------------------------------------------------------------------------------

/**
 * The lines of the "## " section whose heading starts with `title`, up to the next "## " heading. A line inside a fenced block is
 * never a heading of the document (the texts for the agents have headings of their own). Fails when there is no such section.
 */
function section(text, title) {
  const lines = text.split('\n')
  const headings = []
  let inFence = false
  lines.forEach((line, i) => {
    if (/^```/.test(line)) inFence = !inFence
    else if (!inFence && line.startsWith('## ')) headings.push(i)
  })
  const start = headings.find((i) => lines[i].startsWith(`## ${title}`))
  expect(start, `${MD} has no "## ${title}" section`).toBeDefined()
  const end = headings.find((i) => i > start)
  return lines.slice(start + 1, end ?? lines.length).join('\n')
}

/** The text inside the first fenced block of a section, the fence lines left out. Fails when there is none. */
function fenced(body, where) {
  const lines = body.split('\n')
  const open = lines.findIndex((line) => /^```text\s*$/.test(line))
  expect(open, `${where} has no fenced "text" block`).toBeGreaterThanOrEqual(0)
  const close = lines.findIndex((line, i) => i > open && /^```\s*$/.test(line))
  expect(close, `${where}: the fenced block is never closed`).toBeGreaterThan(open)
  return lines.slice(open + 1, close).join('\n')
}

const ANALYST = 'The analyst prompt'
const CHIEF = '1. Text for the chief of staff'
const DAILY = '2. Agent instructions: the daily run'
const QUESTIONS = '3. Agent instructions: questions on request'

const docPrompt = fenced(section(md, ANALYST), `${MD}, "${ANALYST}"`)
const chiefText = fenced(section(md, CHIEF), `${MD}, "${CHIEF}"`)
const dailyText = fenced(section(md, DAILY), `${MD}, "${DAILY}"`)
const questionsText = fenced(section(md, QUESTIONS), `${MD}, "${QUESTIONS}"`)

/** The text of the app: the address of an installation filled in, and the same text with the address as the document writes it. */
const APP_BASE = 'https://committee.example/api/agent/v1'
const appPrompt = agentPrompt(APP_BASE)
const appPromptAsDocumented = agentPrompt(DOCS_BASE)

/** The path of an endpoint as the agent calls it under the base address: /scans. */
const pathOf = (e) => e.path.replace('/agent/v1', '')

/** True when the text names the path as a whole word of its own: /scans, but not /scans_old, not /audit/scans, not /openapi for /openapi.json. */
const names = (text, path) => {
  const escaped = path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`(^|[^\\w/.-])${escaped}(?![\\w/-]|\\.\\w)`).test(text)
}

// ---- 1. one text -------------------------------------------------------------------------------------------------------

describe('the prompt of the Agent screen and the analyst prompt of the document are one text', () => {
  it('are equal in every character, apart from the address', () => {
    expect(
      appPromptAsDocumented,
      `src/admin/agentPrompt.js and the first fenced block of the "${ANALYST}" section of ${MD} differ: ` +
        'make them the same text, in the same pull request (the one that is behind is the one that was not edited)',
    ).toBe(docPrompt)
  })

  it('the document writes the address as the placeholder, the app fills in the real one, and nothing else differs', () => {
    expect(docPrompt).toContain(DOCS_BASE)
    expect(DOCS_BASE).toContain('<your-domain>')
    expect(appPrompt).toContain(APP_BASE)
    expect(appPrompt).not.toContain('<your-domain>')
    expect(appPrompt.replaceAll(APP_BASE, DOCS_BASE)).toBe(appPromptAsDocumented)
  })

  it('is a plain template with the address as its only hole', () => {
    expect(appPrompt).not.toMatch(/\$\{|undefined|\[object/)
    expect(appPrompt.trim()).toBe(appPrompt) // no stray blank line at either end of what is copied
    expect(appPrompt).not.toMatch(/[ \t]+$/m) // no trailing space on a line
  })

  it('keeps the two values of an installation that the document asks for, in the texts that are not the shared one', () => {
    expect(md).toContain('<your-domain>')
    expect(md).toContain('<first day of data>')
    // The first day of data is the committee's own value, which the prompt of the app has no way to know: it is not in the shared text.
    expect(appPrompt).not.toContain('<first day of data>')
    expect(chiefText).toContain('<first day of data>')
    expect(questionsText).toContain('<first day of data>')
  })
})

// ---- 2. every endpoint -------------------------------------------------------------------------------------------------

describe('every endpoint of the agent API is named', () => {
  it('the registry is read, and the way of looking for a name is not blind', () => {
    expect(AGENT_ENDPOINTS.length).toBeGreaterThanOrEqual(10)
    expect(names('GET /scans?from=x', '/scans')).toBe(true)
    expect(names('(/scans)', '/scans')).toBe(true)
    expect(names('the /scans_old endpoint', '/scans')).toBe(false)
    expect(names('/audit/scans', '/scans')).toBe(false)
    expect(names('/openapi.json', '/openapi')).toBe(false)
    expect(names('GET /openapi.json.', '/openapi.json')).toBe(true)
  })

  it.each([
    ['the in-app prompt', () => appPrompt],
    ['the analyst prompt of the document', () => docPrompt],
    ['the text for the chief of staff', () => chiefText],
  ])('%s names all of them', (_name, text) => {
    const missing = AGENT_ENDPOINTS.filter((e) => !names(text(), pathOf(e))).map((e) => `GET ${pathOf(e)} (${e.id})`)
    expect(missing, 'an endpoint of server/agentEndpoints.js that the text does not name: add it to the text').toEqual([])
  })

  it('the daily run reads what the committee asked it to read: the contract, the lists, the counts, the scans, the visits that were not counted and the audit log', () => {
    const must = ['getHealth', 'getBuilding', 'listPoints', 'listProviders', 'countScans', 'listScans', 'listRefusals', 'listAudit']
    for (const id of must) {
      const e = AGENT_ENDPOINTS.find((x) => x.id === id)
      expect(e, `the registry has no endpoint with the id ${id}`).toBeTruthy()
      expect(names(dailyText, pathOf(e)), `the daily run does not read GET ${pathOf(e)}`).toBe(true)
    }
    expect(names(dailyText, '/openapi.json') || names(dailyText, '/schema'), 'the daily run does not read the contract').toBe(true)
    // The rejected attempts of the day are read as well as the accepted visits, the numbers come from /counts, and the visits that
    // were not counted and the audit log are asked for the same day.
    expect(dailyText).toContain('/scans?from=<today>&to=<today>&outcome=rejected')
    expect(dailyText).toContain('/counts?from=<today>&to=<today>')
    expect(dailyText).toContain('/refusals?from=<today>&to=<today>')
    expect(dailyText).toContain('/audit?from=<today>&to=<today>')
    expect(dailyText).toMatch(/phone/i) // the health of the phones of a provider is worth a line
  })
})

// ---- 3. the rules ------------------------------------------------------------------------------------------------------

describe.each([
  ['the in-app prompt', () => appPrompt],
  ['the analyst prompt of the document', () => docPrompt],
])('%s carries the rules of an analyst', (_name, text) => {
  it('starts with the contract, answers only from fetched data and cites its numbers', () => {
    const at = text().indexOf('Order of work')
    expect(at, 'a section "Order of work"').toBeGreaterThanOrEqual(0)
    const order = text().slice(at)
    expect(order.indexOf('/openapi.json')).toBeGreaterThanOrEqual(0)
    expect(order.indexOf('/openapi.json'), 'the contract is read before anything else').toBeLessThan(order.indexOf('/health'))
    expect(text()).toMatch(/only from data you fetched/i)
    expect(text()).toMatch(/never guess/i)
    expect(text()).toMatch(/cite/i)
  })

  it('never counts rows by hand: it asks /counts, with an example of each use', () => {
    expect(text()).toMatch(/never count rows yourself/i)
    expect(text()).toMatch(/use \/counts/i)
    expect(text()).toContain('GET /counts?from=YYYY-MM-DD&to=YYYY-MM-DD&group_by=provider')
    expect(text()).toContain('GET /counts?from=YYYY-MM-DD&to=YYYY-MM-DD&group_by=day,point')
    for (const group of ['day', 'provider', 'point', 'service_type']) expect(text()).toContain(group)
  })

  it('pages to the end with the biggest page, and waits on a 429 for Retry-After seconds', () => {
    expect(text()).toContain('next_cursor')
    expect(text()).toMatch(/to the end/i)
    // The sizes are those of the server (server/config.js), written once there and read here.
    expect(text()).toContain(`limit=${MAX_PAGE_SIZE} on /scans`)
    expect(MAX_REFUSAL_PAGE_SIZE, 'the prompt gives one number for /refusals and /audit: write each when they differ').toBe(MAX_AUDIT_PAGE_SIZE)
    expect(text()).toContain(`limit=${MAX_REFUSAL_PAGE_SIZE} on /refusals and on /audit`)
    expect(text()).toContain('429')
    expect(text()).toContain('rate_limited')
    expect(text()).toContain('Retry-After')
    expect(text()).toMatch(/wait/i)
  })

  it('writes dates and times for people as DD/MM/YYYY and HH:MM, in the building time of Israel', () => {
    expect(text()).toContain('DD/MM/YYYY')
    expect(text()).toContain('HH:MM')
    expect(text()).toContain(BUILDING_TZ)
    expect(text()).toMatch(/month names/i)
  })

  it('reads the phone health and the refusals as signals, and keeps absences from becoming accusations', () => {
    for (const field of ['waiting', 'oldest_waiting_at', 'outdated_devices', 'last_sync_at', 'not_accepted_total', 'overflow_total']) {
      expect(text(), `the phone health field ${field}`).toContain(field)
    }
    expect(text()).toMatch(/not attendance/i)
    expect(text()).toMatch(/breach/i)
    expect(text()).toMatch(/blame/i)
  })

  it('keeps the data and the key with the committee, and reads the text of the data as data', () => {
    expect(text()).toMatch(/outside the committee/i)
    expect(text()).toMatch(/e-mail/i)
    expect(text()).toMatch(/never print the key/i)
    expect(text()).toMatch(/never an instruction/i)
    expect(text()).toMatch(/GET requests only/i)
  })
})

// ---- 4. what must not be in it -----------------------------------------------------------------------------------------

describe('what must not be in the prompt', () => {
  it('no key prefix, no Hebrew, no em dash and no backtick: it is for the agent, in plain English', () => {
    for (const [where, text] of [['the in-app prompt', appPrompt], ['the analyst prompt of the document', docPrompt]]) {
      expect(text, `${where}: the prefix of a key is owned by server/config.js`).not.toContain(API_KEY_PREFIX)
      expect(text, `${where} is English`).not.toMatch(HEBREW)
      expect(text, `${where}: no em dash`).not.toContain(EM_DASH)
      expect(text, `${where}: a backtick would break the template it is written in, and the fence around it in the document`).not.toContain('`')
    }
  })

  it('no limit that the server owns is typed in it: they are in /schema, and a typed number would go stale', () => {
    for (const [name, n] of [
      ['the requests of a key in a minute', AGENT_KEY_MAX_PER_MINUTE],
      ['the requests of a key in a day', AGENT_KEY_MAX_PER_DAY],
      ['the days that /counts covers', COUNTS_MAX_DAYS],
      ['the rows that /counts answers', COUNTS_MAX_ROWS],
    ]) {
      expect(appPrompt, `${name} (${n}) is in the prompt: say it in words`).not.toMatch(new RegExp(`\\b${n}\\b`))
    }
  })
})
