import { atom, read, update } from 'claude-code'
import type { Args, EngineInterface, Register, SessionRateLimit, Timer } from 'claude-code'

import type { Pending } from '../types'

const isEnabled = atom({ plugin: 'auto-resume', key: 'isEnabled' } as const, false)
const pending = atom({ plugin: 'auto-resume', key: 'pending' } as const, null as Pending | null)
const streak = atom({ plugin: 'auto-resume', key: 'streak' } as const, 0)

/** Slack after the reported reset, so the window is surely open again. */
const BUFFER_MS = 60_000
/** With no reset time reported: how long until the next attempt. */
const RETRY_MS = 15 * 60_000
/** How many resumes in a row may hit the limit again before giving up. */
const MAX_STREAK = 8

const RESUME_TEXT =
  'The usage limit has reset. Continue the interrupted task exactly where you left off. ' +
  'If nothing was left unfinished, say so in one line.'

/** The note Claude Code injects when the limit is hit and the turn gets a short grace to wrap up. */
const LIMIT_NOTE = /usage limit reached/i

const isLimitNote = (m: Args<'session.append'>['message']) =>
  m.type === 'user' &&
  m.isMeta === true &&
  m.content.some(b => b.type === 'text' && typeof b.text === 'string' && LIMIT_NOTE.test(b.text))

const hhmm = (ms: number) => {
  const d = new Date(ms)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** The latest reset among exhausted windows that still lie ahead. */
const blockingReset = (limits: SessionRateLimit[], now: number): number | null => {
  const resets = limits
    .filter(l => l.resetsAt !== undefined && l.percentUsed >= 100)
    .map(l => Date.parse(l.resetsAt as string))
    .filter(t => Number.isFinite(t) && t > now)
  return resets.length === 0 ? null : Math.max(...resets)
}

/** After a rate-limit error: the blocking reset, else the 5-hour window's reset. */
const resetAfterError = (limits: SessionRateLimit[], now: number): number | null => {
  const full = blockingReset(limits, now)
  if (full !== null) return full
  const five = limits.find(l => l.kind === 'five_hour' && l.resetsAt !== undefined)
  const t = five ? Date.parse(five.resetsAt as string) : NaN
  return Number.isFinite(t) && t > now ? t : null
}

// Module state: a reload starts it over, and session.start re-arms from `pending`.
let timer: Timer | null = null

const cancel = () => {
  timer?.cancel()
  timer = null
}

const showStatus = async ($: EngineInterface) => {
  if (!(await read($, isEnabled))) return $.ui.status(undefined)
  const p = await read($, pending)
  $.ui.status(p ? `auto-resume: resuming at ${hhmm(p.at)}` : 'auto-resume: on')
}

const fire = async ($: EngineInterface) => {
  timer = null
  if (!(await read($, isEnabled)) || (await read($, pending)) === null) return
  await update($, pending, () => null)
  await showStatus($)
  $.ui.toast('auto-resume: limit should be clear, resuming …')
  void $.prompt.submit({ text: RESUME_TEXT, asUser: true })
}

const arm = async ($: EngineInterface, next: Pending) => {
  cancel()
  await update($, pending, () => next)
  const ms = Math.max(0, next.at - (await $.clock.now()))
  timer = $.clock.after(ms, () => void fire($))
  await showStatus($)
}

/** Schedules a resume after a rate limit, or gives up after MAX_STREAK failures. */
const schedule = async ($: EngineInterface) => {
  // One limit can be reported twice (the wrap-up note, then the cut-off error).
  if ((await read($, pending)) !== null) return
  const now = await $.clock.now()
  const { rateLimits } = await $.session.usage()
  const reset = resetAfterError(rateLimits, now)
  const count = await update($, streak, n => n + 1)
  if (count > MAX_STREAK) {
    cancel()
    await update($, pending, () => null)
    await showStatus($)
    $.ui.toast(`auto-resume: hit the limit ${MAX_STREAK} times in a row, giving up.`)
    return
  }
  const at = reset === null ? now + RETRY_MS : reset + BUFFER_MS
  await arm($, { at })
  $.ui.toast(
    reset === null
      ? `auto-resume: limit reached, no reset time known – retrying at ${hhmm(at)}.`
      : `auto-resume: limit reached – resuming automatically at ${hhmm(at)}.`,
  )
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'auto-resume',
      description: 'Resume automatically once a usage limit resets: on | off | status',
    })
    // A reload dropped the timer; pick the scheduled time up again.
    const p = await read($, pending)
    if (p !== null && (await read($, isEnabled))) await arm($, p)
    else await showStatus($)
    return next(e)
  })

  on('command.run', { command: 'auto-resume' }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()

    if (arg === 'off') {
      cancel()
      await update($, isEnabled, () => false)
      await update($, pending, () => null)
      await update($, streak, () => 0)
      await showStatus($)
      return { text: 'auto-resume is off.' }
    }

    if (arg === 'on') {
      await update($, isEnabled, () => true)
      await update($, streak, () => 0)
      // Already at the limit? Schedule for the reset right away.
      const now = await $.clock.now()
      const reset = blockingReset((await $.session.usage()).rateLimits, now)
      if (reset !== null) {
        await arm($, { at: reset + BUFFER_MS })
        return { text: `auto-resume is on. Limit reached – resuming at ${hhmm(reset + BUFFER_MS)}.` }
      }
      await showStatus($)
      return { text: 'auto-resume is on. After a usage limit I resume once it resets.' }
    }

    const isOn = await read($, isEnabled)
    const p = await read($, pending)
    const state = !isOn ? 'off' : p ? `on, resuming at ${hhmm(p.at)}` : 'on, nothing scheduled'
    return { text: `auto-resume: ${state}. Usage: /auto-resume on | off | status` }
  })

  // Hard stop: the request itself failed on the limit.
  on('classic.StopFailure', async ($, e, next) => {
    if (e.error === 'rate_limit' && (await read($, isEnabled))) await schedule($)
    return next(e)
  })

  // Soft stop: Claude Code tells the model the limit is reached and lets it wrap up.
  on('session.append', async ($, e, next) => {
    if (e.agentId === undefined && isLimitNote(e.message) && (await read($, isEnabled))) {
      await schedule($)
    }
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId !== undefined || !(await read($, isEnabled))) return next(e)
    if ((await read($, pending)) !== null) return next(e)
    // Fallback: the turn ended while a window is exhausted, however that was reported.
    const now = await $.clock.now()
    if (blockingReset((await $.session.usage()).rateLimits, now) !== null) await schedule($)
    // A turn that answered with nothing scheduled resets the failure count.
    else if (e.reason === 'answer') await update($, streak, () => 0)
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
