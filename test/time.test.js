import test from 'node:test'
import assert from 'node:assert/strict'

import { clockMinutes, dailyDue, epochMs, localDate } from '../src/time.js'

test('epochMs accepts the ISO string the dream watermark is written as', () => {
  // Regression: the panel used to require a number, so every real watermark
  // (an ISO string) rendered as "never" even though the night run happened.
  const watermark = JSON.parse('{"lastRunAt":"2026-11-18T20:02:53.438Z"}').lastRunAt
  assert.equal(epochMs(watermark), Date.parse('2026-11-18T20:02:53.438Z'))
  assert.ok(epochMs(watermark) > 0)
})

test('epochMs keeps accepting the epoch-ms state older releases wrote', () => {
  assert.equal(epochMs(1794475086504), 1794475086504)
  assert.equal(epochMs('1794475086504'), 1794475086504)
  assert.equal(epochMs(new Date(1794475086504)), 1794475086504)
})

test('epochMs folds absent and unparseable values into zero', () => {
  assert.equal(epochMs(undefined), 0)
  assert.equal(epochMs(null), 0)
  assert.equal(epochMs(''), 0)
  assert.equal(epochMs('   '), 0)
  assert.equal(epochMs('not a date'), 0)
  assert.equal(epochMs(Number.NaN), 0)
})

test('localDate pads to YYYY-MM-DD in local time', () => {
  assert.equal(localDate(new Date(2026, 0, 5, 23, 59)), '2026-01-05')
  assert.equal(localDate(new Date(2026, 10, 19, 4, 0)), '2026-11-19')
})

test('clockMinutes parses HH:MM and rejects malformed settings', () => {
  assert.equal(clockMinutes('04:00'), 240)
  assert.equal(clockMinutes('4:00'), 240)
  assert.equal(clockMinutes('00:00'), 0)
  assert.equal(clockMinutes('23:59'), 1439)
  assert.equal(clockMinutes('24:00'), undefined)
  assert.equal(clockMinutes('04:60'), undefined)
  assert.equal(clockMinutes('4点'), undefined)
  assert.equal(clockMinutes(''), undefined)
})

test('dailyDue is due from the target minute onwards, once per day', () => {
  const target = '04:00'
  assert.equal(dailyDue(new Date(2026, 10, 19, 3, 59), target, ''), false, 'before the clock')
  assert.equal(dailyDue(new Date(2026, 10, 19, 4, 0), target, ''), true, 'exactly on the clock')
  assert.equal(dailyDue(new Date(2026, 10, 19, 4, 0), target, '2026-11-19'), false, 'already fired today')
  assert.equal(dailyDue(new Date(2026, 10, 19, 4, 1), target, ''), true, 'a tick that drifted past the minute still runs')
  assert.equal(dailyDue(new Date(2026, 10, 19, 14, 30), target, ''), true, 'a process started later catches up')
  assert.equal(dailyDue(new Date(2026, 10, 20, 4, 0), target, '2026-11-19'), true, 'the next day fires again')
})

test('dailyDue treats an empty or malformed clock as disabled', () => {
  const noon = new Date(2026, 10, 19, 12, 0)
  assert.equal(dailyDue(noon, '', ''), false)
  assert.equal(dailyDue(noon, '   ', ''), false)
  assert.equal(dailyDue(noon, '4点', ''), false)
  assert.equal(dailyDue(noon, '25:00', ''), false)
})
