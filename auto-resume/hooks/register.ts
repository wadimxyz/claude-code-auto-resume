import { atom, read, update } from 'claude-code'
import type { Args, EngineInterface, Register, SessionRateLimit, Timer } from 'claude-code'

import type { Pending, Signal } from '../types'

const isEnabled = atom({ plugin: 'auto-resume', key: 'isEnabled' } as const, false)
const pending = atom({ plugin: 'auto-resume', key: 'pending' } as const, null as Pending | null)
const streak = atom({ plugin: 'auto-resume', key: 'streak' } as const, 0)
const lastSignal = atom({ plugin: 'auto-resume', key: 'lastSignal' } as const, null as Signal | null)

/** Slack after the reported reset, so the window is surely open again. */
const BUFFER_MS = 60_000
/** With no reset time reported: how long until the next attempt. */
const RETRY_MS = 15 * 60_000
/** How many resumes in a row may hit the limit again before giving up. */
const MAX_STREAK = 8
/** `/auto-resume test` without a duration. */
const TEST_DEFAULT_MS = 2 * 60_000

const RESUME_TEXT =
  'The usage limit has reset. Continue the interrupted task exactly where you left off. ' +
  'If nothing was left unfinished, say so in one line.'
const TEST_TEXT =
  'auto-resume test: this prompt was sent automatically by the auto-resume plugin. ' +
  'Reply with one line confirming you received it, and do nothing else.'

/** The note Claude Code injects when the limit is hit and the turn gets a short grace to wrap up. */
const LIMIT_NOTE = /usage limit reached/i

const isLimitNote = (m: Args<'session.append'>['message']) =>
  m.type === 'user' &&
  m.isMeta === true &&
  m.content.some(b => b.type === 'text' && typeof b.text === 'string' && LIMIT_NOTE.test(b.text))

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

/** `14:31`, or `Tue 14:31` when it is not within the next 20 hours. */
const when = (ms: number, now: number) => {
  const d = new Date(ms)
  const pad = (n: number) => String(n).padStart(2, '0')
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}`
  return Math.abs(ms - now) < 20 * 3_600_000 ? time : `${DAYS[d.getDay()]} ${time}`
}

const parseReset = (l: SessionRateLimit) => {
  const t = l.resetsAt === undefined ? NaN : Date.parse(l.resetsAt)
  return Number.isFinite(t) ? t : null
}

/** The latest reset among exhausted windows that still lie ahead. */
const blockingReset = (limits: SessionRateLimit[], now: number): number | null => {
  const resets = limits
    .filter(l => l.percentUsed >= 100)
    .map(parseReset)
    .filter((t): t is number => t !== null && t > now)
  return resets.length === 0 ? null : Math.max(...resets)
}

/** After a limit signal: the blocking reset, else the 5-hour window's reset. */
const resetAfterSignal = (limits: SessionRateLimit[], now: number): number | null => {
  const full = blockingReset(limits, now)
  if (full !== null) return full
  const five = limits.find(l => l.kind === 'five_hour')
  const t = five ? parseReset(five) : null
  return t !== null && t > now ? t : null
}

// Module state: a reload starts it over, and session.start re-arms from `pending`.
let timer: Timer | null = null

const cancel = () => {
  timer?.cancel()
  timer = null
}

const showStatus = async ($: EngineInterface) => {
  const p = await read($, pending)
  const now = await $.clock.now()
  if (p?.kind === 'test') return $.ui.status(`auto-resume: test at ${when(p.at, now)}`)
  if (!(await read($, isEnabled))) return $.ui.status(undefined)
  $.ui.status(p ? `auto-resume: resuming at ${when(p.at, now)}` : 'auto-resume: on')
}

const note = async ($: EngineInterface, what: string, outcome: string) => {
  const at = await $.clock.now()
  await update($, lastSignal, () => ({ what, at, outcome }))
}

const fire = async ($: EngineInterface) => {
  timer = null
  const p = await read($, pending)
  if (p === null) return
  if (p.kind === 'resume' && !(await read($, isEnabled))) return
  await update($, pending, () => null)
  await showStatus($)
  const isTest = p.kind === 'test'
  $.ui.toast(isTest ? 'auto-resume: sending the test prompt …' : 'auto-resume: limit should be clear, resuming …')
  void $.prompt.submit({ text: isTest ? TEST_TEXT : RESUME_TEXT, asUser: true })
}

const arm = async ($: EngineInterface, next: Pending) => {
  cancel()
  await update($, pending, () => next)
  const ms = Math.max(0, next.at - (await $.clock.now()))
  timer = $.clock.after(ms, () => void fire($))
  await showStatus($)
}

/** Answers a limit signal: schedules a resume, or says why not. */
const onLimit = async ($: EngineInterface, what: string) => {
  if (!(await read($, isEnabled))) return note($, what, 'ignored: auto-resume was off')
  // One limit is often reported more than once (note, window, error).
  const p = await read($, pending)
  if (p?.kind === 'resume') return note($, what, 'already scheduled')

  const now = await $.clock.now()
  const reset = resetAfterSignal((await $.session.usage()).rateLimits, now)
  const count = await update($, streak, n => n + 1)
  if (count > MAX_STREAK) {
    cancel()
    await update($, pending, () => null)
    await showStatus($)
    $.ui.toast(`auto-resume: hit the limit ${MAX_STREAK} times in a row, giving up.`)
    return note($, what, `gave up after ${MAX_STREAK} resumes in a row`)
  }

  const at = reset === null ? now + RETRY_MS : reset + BUFFER_MS
  await arm($, { at, kind: 'resume' })
  const outcome =
    reset === null
      ? `no reset time reported – retrying at ${when(at, now)}`
      : `resuming at ${when(at, now)}`
  $.ui.toast(`auto-resume: limit reached – ${outcome}.`)
  return note($, what, outcome)
}

/** Checks the rate-limit windows: the primary signal, however the limit was announced. */
const checkWindows = async ($: EngineInterface, rateLimits: SessionRateLimit[]) => {
  const now = await $.clock.now()
  const full = rateLimits.find(l => l.percentUsed >= 100 && (parseReset(l) ?? 0) > now)
  if (full !== undefined) await onLimit($, `${full.kind} window at ${full.percentUsed} %`)
}

const parseDuration = (text: string): number | null => {
  if (text === '') return TEST_DEFAULT_MS
  const m = /^(\d+)\s*(s|m)?$/.exec(text)
  if (m === null) return null
  const ms = Number(m[1]) * (m[2] === 's' ? 1000 : 60_000)
  return ms <= 60 * 60_000 ? ms : null
}

const statusText = async ($: EngineInterface) => {
  const now = await $.clock.now()
  const isOn = await read($, isEnabled)
  const p = await read($, pending)
  const s = await read($, lastSignal)
  const { rateLimits } = await $.session.usage()

  const state = !isOn ? 'off' : 'on'
  const plan =
    p === null ? 'nothing scheduled' : `${p.kind === 'test' ? 'test' : 'resume'} at ${when(p.at, now)}`
  const windows =
    rateLimits.length === 0
      ? 'no rate-limit readings yet (they come with the first response, on a subscription)'
      : rateLimits
          .map(l => {
            const t = parseReset(l)
            return `${l.kind} ${l.percentUsed} %${t === null ? '' : `, resets ${when(t, now)}`}`
          })
          .join(' · ')
  const signal = s === null ? 'none yet' : `${s.what} at ${when(s.at, now)} → ${s.outcome}`

  return [
    `auto-resume: ${state}, ${plan}`,
    `windows: ${windows}`,
    `last signal: ${signal}`,
    'usage: /auto-resume on | off | status | test [2m|30s]',
  ].join('\n')
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'auto-resume',
      description: 'Resume automatically once a usage limit resets: on | off | status | test [2m]',
    })
    // A reload dropped the timer; pick the scheduled time up again.
    const p = await read($, pending)
    if (p !== null && (p.kind === 'test' || (await read($, isEnabled)))) await arm($, p)
    else await showStatus($)
    return next(e)
  })

  on('command.run', { command: 'auto-resume' }, async ($, e) => {
    const [verb = '', ...rest] = e.args.trim().toLowerCase().split(/\s+/)

    if (verb === 'off') {
      cancel()
      await update($, isEnabled, () => false)
      await update($, pending, () => null)
      await update($, streak, () => 0)
      await showStatus($)
      return { text: 'auto-resume is off.' }
    }

    if (verb === 'on') {
      await update($, isEnabled, () => true)
      await update($, streak, () => 0)
      // Already at the limit? Schedule for the reset right away.
      await checkWindows($, (await $.session.usage()).rateLimits)
      await showStatus($)
      return { text: await statusText($) }
    }

    if (verb === 'test') {
      const ms = parseDuration(rest.join(''))
      if (ms === null) return { text: 'Usage: /auto-resume test [2m|30s] (at most 60m)' }
      const at = (await $.clock.now()) + ms
      await arm($, { at, kind: 'test' })
      return {
        text:
          `Test scheduled for ${when(at, at)}. Leave the session idle: a test prompt should ` +
          'arrive then and start a turn on its own. Typing a prompt yourself cancels it.',
      }
    }

    return { text: await statusText($) }
  })

  // Primary signal: a rate-limit window reached 100 %, however it was announced.
  on('session.measure', async ($, e, next) => {
    if (e.changed.includes('rateLimits')) await checkWindows($, e.rateLimits)
    return next(e)
  })

  // Soft stop: Claude Code tells the model the limit is reached and lets it wrap up.
  on('session.append', async ($, e, next) => {
    if (e.agentId === undefined && isLimitNote(e.message)) await onLimit($, 'usage-limit note')
    return next(e)
  })

  // Hard stop: the request itself failed on the limit.
  on('classic.StopFailure', async ($, e, next) => {
    if (e.error === 'rate_limit') await onLimit($, 'rate_limit error')
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId !== undefined) return next(e)
    // Safety net: the turn ended while a window is exhausted.
    await checkWindows($, (await $.session.usage()).rateLimits)
    // A turn that answered with nothing scheduled resets the failure count.
    if (e.reason === 'answer' && (await read($, pending)) === null) await update($, streak, () => 0)
    return next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    // The person typed something themselves: they take over, drop the scheduled resume.
    const isPerson = e.origin.kind === 'composer' || e.origin.kind === 'bridge'
    if (isPerson && (await read($, pending)) !== null) {
      cancel()
      await update($, pending, () => null)
      await showStatus($)
    }
    return next(e)
  })
}
