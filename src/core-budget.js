/**
 * Byte budget for `MEMORY.md`.
 *
 * The core memory is injected into *every* system prompt, so it is the one file
 * whose size is paid on every turn. It is therefore capped: the agent writes
 * events, logs and per-project detail into daily notes instead, and the cap is
 * enforced at write time rather than discovered as silent truncation.
 *
 * @module dsh-long-term-memory/core-budget
 */

/** Default budget in bytes (matches `inject.memoryMdMaxBytes`). */
export const DEFAULT_CORE_BUDGET = 4096

/** Smallest budget this guard enforces, so a bad config cannot lock the file. */
export const CORE_BUDGET_FLOOR = 1024

/**
 * Normalize a configured budget.
 * @param {unknown} limit - configured byte limit.
 * @returns {number} effective byte budget.
 */
export function coreBudgetBytes(limit) {
  const value = Number(limit)
  if (!Number.isFinite(value) || value <= 0) return DEFAULT_CORE_BUDGET
  return Math.max(CORE_BUDGET_FLOOR, Math.trunc(value))
}

/**
 * Describe a MEMORY.md size against its budget.
 * @param {number} bytes - UTF-8 byte length of the resulting file.
 * @param {unknown} limit - configured byte limit.
 * @returns {{bytes: number, limit: number, remaining: number, over: boolean}} usage.
 */
export function coreUsage(bytes, limit) {
  const budget = coreBudgetBytes(limit)
  const used = Math.max(0, Math.trunc(Number(bytes) || 0))
  return { bytes: used, limit: budget, remaining: budget - used, over: used > budget }
}

/** Compact human label such as `核心记忆 2.1KB/4KB`. */
export function formatCoreUsage(language, usage) {
  const kb = (value) => {
    const text = (value / 1024).toFixed(1)
    return (text.endsWith('.0') ? text.slice(0, -2) : text) + 'KB'
  }
  const zh = language === 'zh'
  return zh
    ? `核心记忆 ${kb(usage.bytes)}/${kb(usage.limit)}`
    : `core memory ${kb(usage.bytes)}/${kb(usage.limit)}`
}

/**
 * The refusal shown to the agent when a write would blow the budget.
 *
 * It has to say *where the content belongs*, not merely that it is too big:
 * otherwise the model retries with the same text trimmed by a few characters.
 *
 * @param {'zh'|'en'} language - prompt language.
 * @param {{bytes: number, limit: number, remaining: number}} usage - resulting size.
 * @returns {string} error message.
 */
export function coreBudgetMessage(language, usage) {
  const kb = (value) => `${(value / 1024).toFixed(1)}KB`
  if (language === 'zh') {
    return `MEMORY.md 超出核心记忆预算：写入后会变成 ${kb(usage.bytes)}，上限 ${kb(usage.limit)}（还差 ${kb(Math.max(0, usage.bytes - usage.limit))}）。`
      + 'MEMORY.md 只放长期有效的约定与边界（偏好、红线、稳定事实），不放过程记录、版本流水账或每日进展——'
      + '把这些写进 memory/<日期>/<主题>.md，或先用 memory_edit 精简 MEMORY.md 再重试。'
  }
  return `MEMORY.md would exceed the core-memory budget: ${kb(usage.bytes)} after this write, limit ${kb(usage.limit)} (over by ${kb(Math.max(0, usage.bytes - usage.limit))}).`
    + ' MEMORY.md holds long-lived agreements and boundaries only (preferences, red lines, stable facts), never process logs, release notes or daily progress —'
    + ' write those to memory/<date>/<topic>.md, or trim MEMORY.md first with memory_edit.'
}
