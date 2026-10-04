# auto-resume for Claude Code

When a Claude Code session stops because the usage limit was reached, **auto-resume**
waits until the limit window resets and then continues the interrupted task for you –
no need to come back to the terminal. It does nothing until you switch it on.

## Install

```sh
claude plugin marketplace add wadimxyz/claude-code-auto-resume
claude plugin install auto-resume@wadim-mods
```

Then run `/reload-plugins` in a running session (new sessions load it by themselves).

Requires a Claude Code version with function-hook plugins. Tested with **2.1.289**.
That plugin API is early access and may change between releases.

## Usage

| Command | Effect |
| --- | --- |
| `/auto-resume on` | Switch on for this session. If you are at the limit already, the resume is scheduled right away. |
| `/auto-resume off` | Switch off and drop a scheduled resume. |
| `/auto-resume status` | Show the state, the current rate-limit windows and the last limit signal with what the plugin did about it. |
| `/auto-resume test [2m\|30s]` | Send a harmless test prompt after the given time (default 2 minutes), to check end to end that an idle session really picks it up. Works while off. |

It is off in every new session. While on, the status line shows `auto-resume: on`
or `auto-resume: resuming at 14:31`.

**Try it once after installing:** `/auto-resume test 30s`, leave the session idle, and
a test prompt should arrive and start a turn on its own.

## How it works

1. The plugin watches for the usage limit through three independent signals; the first
   one to arrive schedules the resume, the others are recognised as the same limit:
   - **rate-limit windows (primary)** – a window (`five_hour`, `seven_day`) reaches 100 %.
     These are the same readings the status line shows. Checked whenever they change and
     at the end of every turn.
   - **soft stop** – Claude Code tells the model *"Usage limit reached; a short grace
     allowance remains …"* and the model wraps up on its own.
   - **hard stop** – a request fails with a `rate_limit` error.
2. It takes the reset time of the exhausted window (the 5-hour window, or the 7-day window
   if that one is full).
3. One minute after that reset it submits:
   *"The usage limit has reset. Continue the interrupted task exactly where you left off.
   If nothing was left unfinished, say so in one line."*
4. If no reset time is known, it retries every 15 minutes. After 8 resumes in a row
   that hit the limit again, it gives up and tells you so.
5. If you type a prompt yourself in the meantime, the scheduled resume is dropped.

If nothing happened, `/auto-resume status` tells you why: which signal was seen last,
when, and what came of it (scheduled, already scheduled, ignored because the plugin was
off, gave up).

## Things to know

- **The session has to stay open.** The timer lives in the Claude Code process; if the
  machine sleeps, the resume happens after it wakes up.
- **A full 7-day window means a long wait** – the plugin waits for that reset, too.
- **It runs unattended.** Whatever permission mode the session uses applies to the
  resumed work as well. Think twice before combining it with bypass mode.
- The resumed turn uses up the fresh window right away.
- Subagents or workflows the model stopped while wrapping up are not restarted by the
  plugin itself; the resume prompt asks the model to pick the task up again.

## Development

```sh
claude plugin validate auto-resume
claude plugin test auto-resume
```

## License

MIT
