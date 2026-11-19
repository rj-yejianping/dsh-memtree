/**
 * Time helpers shared by the Auto Dream scheduler, the `memory_status` tool and
 * the browser-facing panel API.
 *
 * The Auto Dream watermark (`mem_metadata/dream-state.json`, `lastRunAt`) is
 * written as an ISO string so the state file stays human-diffable, while state
 * produced by older releases holds epoch milliseconds. Every reader therefore
 * has to accept both shapes: a "number only" check silently folds a real
 * timestamp into zero, which is how a nightly run that *did* happen still shows
 * up as "never" in the panel.
 *
 * @module dsh-memtree/time
 */

/**
 * Normalize a timestamp value to epoch milliseconds.
 *
 * @param {unknown} value - epoch ms, epoch-ms string, ISO/date string, or Date.
 * @returns {number} epoch ms, or 0 when the value is absent or unparseable.
 */
export function epochMs(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0
  if (value instanceof Date) {
    const time = value.getTime()
    return Number.isFinite(time) ? time : 0
  }
  if (typeof value === 'string') {
    const text = value.trim()
    if (text.length === 0) return 0
    if (/^\d{10,}$/.test(text)) return Number(text)
    const time = Date.parse(text)
    return Number.isFinite(time) ? time : 0
  }
  return 0
}

/**
 * Local calendar date of one instant, as `YYYY-MM-DD`.
 *
 * @param {Date} date - the instant.
 * @returns {string} local date.
 */
export function localDate(date) {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

/**
 * Minutes since local midnight for a `HH:MM` clock setting.
 *
 * @param {string} clock - e.g. `'04:00'`.
 * @returns {number | undefined} 0..1439, or undefined when malformed.
 */
export function clockMinutes(clock) {
  if (typeof clock !== 'string') return undefined
  const match = /^(\d{1,2}):(\d{2})$/.exec(clock.trim())
  if (match === null) return undefined
  const hours = Number(match[1])
  const minutes = Number(match[2])
  if (!Number.isInteger(hours) || !Number.isInteger(minutes)) return undefined
  if (hours > 23 || minutes > 59) return undefined
  return hours * 60 + minutes
}

/**
 * Whether the daily clock is due now.
 *
 * A once-a-minute tick makes "now === HH:MM" a fragile test: a tick that drifts
 * over the minute, or a process that is not running at `HH:MM`, skips the whole
 * day with no trace. Treating the schedule as due from `HH:MM` onwards (until
 * the local date has fired once) turns that silent skip into one catch-up pass.
 *
 * @param {Date} now - current time.
 * @param {string} clock - `HH:MM` daily setting; empty disables the schedule.
 * @param {string} lastFiredDate - local `YYYY-MM-DD` that already fired, or ''.
 * @returns {boolean} true when a run is due.
 */
export function dailyDue(now, clock, lastFiredDate) {
  if (typeof clock !== 'string' || clock.trim().length === 0) return false
  const target = clockMinutes(clock)
  if (target === undefined) return false
  if (lastFiredDate === localDate(now)) return false
  return now.getHours() * 60 + now.getMinutes() >= target
}
