import { expect, mock, test } from 'claude-code/testing'
import type { On, SessionRateLimit } from 'claude-code'

const T0 = Date.parse('2026-10-04T10:00:00Z')
const MIN = 60_000

/** The engine beneath the plugin: usage, commands, UI and submitted prompts from memory. */
const world = (on: On, limits: () => SessionRateLimit[]) => {
  const clock = mock.clock(on, { now: T0 })
  const submitted: string[] = []
  const toasts: string[] = []
  on('session.start', async (_$, e) => ({ cwd: e.cwd }))
  on('classic.StopFailure', async () => ({}))
  on('session.usage', async () => ({
    value: {
      startedAt: T0,
      context: { windowSize: 200_000 } as never,
      rateLimits: limits(),
    },
  }))
  on('command.register', async (_$, e) => ({ value: { command: e.name } }))
  on('ui.status', async () => ({ value: undefined }))
  on('ui.toast', async (_$, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  on('prompt.submit', async (_$, e) => {
    if (e.origin.kind === 'plugin') submitted.push(e.text)
    return { text: e.text } as never
  })
  return { clock, submitted, toasts }
}

const start = { cwd: '/tmp', surface: null, isInteractive: true }
const run = (args: string) => ({
  command: 'auto-resume',
  args,
  origin: { kind: 'composer' as const },
  presentation: { isFullscreen: false, columns: 120 },
})
const hitLimit = { error: 'rate_limit' as const }
const fiveHourFull = (resetInMin: number): SessionRateLimit[] => [
  { kind: 'five_hour', percentUsed: 100, resetsAt: new Date(T0 + resetInMin * MIN).toISOString() },
]

test('does nothing unless enabled', async ($, on) => {
  const w = world(on, () => fiveHourFull(30))
  await $.session.start(start)
  await $.classic.StopFailure(hitLimit)
  await w.clock.advance(5 * 60 * MIN)
  expect(w.submitted).toEqual([])
})

test('enabled: resumes after the 5-hour window resets', async ($, on) => {
  const w = world(on, () => fiveHourFull(30))
  await $.session.start(start)
  // Still at the limit when switched on: scheduled right away.
  await $.command.run(run('on'))
  await $.classic.StopFailure(hitLimit)
  await w.clock.advance(30 * MIN)
  expect(w.submitted).toEqual([])
  await w.clock.advance(1 * MIN + 1)
  expect(w.submitted.length).toBe(1)
  expect(w.submitted[0]).toContain('Continue')
})

test('no reset time known: retries after 15 minutes', async ($, on) => {
  const w = world(on, () => [])
  await $.session.start(start)
  await $.command.run(run('on'))
  await $.classic.StopFailure(hitLimit)
  await w.clock.advance(15 * MIN - 1)
  expect(w.submitted).toEqual([])
  await w.clock.advance(2)
  expect(w.submitted.length).toBe(1)
})

test('off drops the scheduled resume', async ($, on) => {
  const w = world(on, () => fiveHourFull(10))
  await $.session.start(start)
  await $.command.run(run('on'))
  await $.classic.StopFailure(hitLimit)
  await $.command.run(run('off'))
  await w.clock.advance(60 * MIN)
  expect(w.submitted).toEqual([])
})

test('a prompt the person types drops the scheduled resume', async ($, on) => {
  const w = world(on, () => fiveHourFull(10))
  await $.session.start(start)
  await $.command.run(run('on'))
  await $.classic.StopFailure(hitLimit)
  await $.prompt.submit({ text: 'something else', wait: false, origin: { kind: 'composer' } })
  await w.clock.advance(60 * MIN)
  expect(w.submitted).toEqual([])
})

test('other errors trigger nothing', async ($, on) => {
  const w = world(on, () => [])
  await $.session.start(start)
  await $.command.run(run('on'))
  await $.classic.StopFailure({ error: 'server_error' })
  await w.clock.advance(60 * MIN)
  expect(w.submitted).toEqual([])
})

test('gives up after 8 failed resumes in a row', async ($, on) => {
  const w = world(on, () => [])
  await $.session.start(start)
  await $.command.run(run('on'))
  for (let i = 0; i < 8; i++) {
    await $.classic.StopFailure(hitLimit)
    await w.clock.advance(15 * MIN + 1)
  }
  expect(w.submitted.length).toBe(8)
  await $.classic.StopFailure(hitLimit)
  await w.clock.advance(60 * MIN)
  expect(w.submitted.length).toBe(8)
  expect(w.toasts.some(t => t.includes('giving up'))).toBe(true)
})

test('session.start re-arms a scheduled resume', async ($, on) => {
  const w = world(on, () => fiveHourFull(20))
  await $.session.start(start)
  await $.command.run(run('on'))
  await $.classic.StopFailure(hitLimit)
  // A second start stands for a reload: the old timer is replaced, not doubled.
  await $.session.start(start)
  await w.clock.advance(21 * MIN + 1)
  expect(w.submitted.length).toBe(1)
})
