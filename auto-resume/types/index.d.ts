export type Pending = {
  /** When to resume, in milliseconds since the epoch. */
  at: number
  /** `resume` continues the interrupted task; `test` only checks the path end to end. */
  kind: 'resume' | 'test'
}

/** The last limit signal the plugin saw, and what it made of it. */
export type Signal = {
  /** What was seen: the wrap-up note, the rate_limit error, a window at 100 %. */
  what: string
  /** When, in milliseconds since the epoch. */
  at: number
  /** What the plugin did about it. */
  outcome: string
}

declare module 'claude-code' {
  interface PluginState {
    'auto-resume': {
      isEnabled: boolean
      pending: Pending | null
      /** Resumes in a row that hit the limit again. */
      streak: number
      lastSignal: Signal | null
    }
  }
}
