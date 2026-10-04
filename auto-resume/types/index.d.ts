export type Pending = {
  /** When to resume, in milliseconds since the epoch. */
  at: number
}

declare module 'claude-code' {
  interface PluginState {
    'auto-resume': {
      isEnabled: boolean
      pending: Pending | null
      /** Resumes in a row that hit the limit again. */
      streak: number
    }
  }
}
