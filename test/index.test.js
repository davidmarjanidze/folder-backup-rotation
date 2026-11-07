/* global setTimeout */
import assert from 'node:assert/strict'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, test } from 'node:test'
import {
  backupFolder,
  listBackups,
  rotateBackups,
  scheduleBackups
} from '../dist/index.js'

let root
let source
let destination

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'folder-backup-rotation-'))
  source = join(root, 'notes')
  destination = join(root, 'backups')
  mkdirSync(join(source, 'sub'), { recursive: true })
  mkdirSync(join(source, 'node_modules'))
  writeFileSync(join(source, 'a.txt'), 'hello')
  writeFileSync(join(source, 'sub', 'b.txt'), 'world')
  writeFileSync(join(source, 'node_modules', 'big.js'), 'skip me')
})

afterEach(() => rmSync(root, { recursive: true, force: true }))

const pad = (n) => String(n).padStart(2, '0')

// Creates an empty backup folder with the name for the given date.
function fakeBackup(date, prefix = 'notes') {
  const name = `${prefix}_${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}_${pad(date.getHours())}-${pad(date.getMinutes())}-${pad(date.getSeconds())}`
  mkdirSync(join(destination, name), { recursive: true })
  return name
}

test('copies the folder', async () => {
  const { path, removed } = await backupFolder({
    source,
    destination,
    skip: ['node_modules']
  })

  assert.match(path, /notes_\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}$/)
  assert.equal(readFileSync(join(path, 'a.txt'), 'utf8'), 'hello')
  assert.equal(readFileSync(join(path, 'sub', 'b.txt'), 'utf8'), 'world')
  assert.equal(existsSync(join(path, 'node_modules')), false)
  assert.deepEqual(removed, [])
  // No partial folder is left behind
  assert.deepEqual(readdirSync(destination), [path.split(/[\\/]/).at(-1)])
})

test('two backups in the same second get different names', async () => {
  const first = await backupFolder({ source, destination, keep: { last: 5 } })
  const second = await backupFolder({ source, destination, keep: { last: 5 } })
  assert.notEqual(first.path, second.path)

  const list = await listBackups(destination, 'notes')
  assert.equal(list.length, 2)
  assert.equal(list[0].path, second.path)
})

test('uses a custom prefix', async () => {
  const { path } = await backupFolder({ source, destination, prefix: 'daily' })
  assert.match(path, /daily_\d{4}/)
})

test('listBackups ignores other files and sorts newest first', async () => {
  const older = fakeBackup(new Date(2026, 0, 1, 10, 0, 0))
  const newer = fakeBackup(new Date(2026, 0, 2, 10, 0, 0))
  fakeBackup(new Date(2026, 0, 3), 'other')
  mkdirSync(join(destination, '.notes_2026-01-04_10-00-00.partial'))
  writeFileSync(join(destination, 'readme.txt'), '')

  const list = await listBackups(destination, 'notes')
  assert.deepEqual(
    list.map((backup) => backup.path),
    [join(destination, newer), join(destination, older)]
  )
  assert.deepEqual(list[1].date, new Date(2026, 0, 1, 10, 0, 0))
})

test('listBackups returns an empty list for a missing folder', async () => {
  assert.deepEqual(await listBackups(join(root, 'nope'), 'notes'), [])
})

test('keeps daily, weekly and monthly backups', async () => {
  // One backup a day at noon from Jan 1 to Mar 1 2026, plus an earlier one
  // on Mar 1.
  for (let day = 0; day < 60; day++) {
    fakeBackup(new Date(2026, 0, 1 + day, 12, 0, 0))
  }
  fakeBackup(new Date(2026, 2, 1, 8, 0, 0))

  const removed = await rotateBackups({
    destination,
    prefix: 'notes',
    keep: { daily: 7, weekly: 4, monthly: 3 }
  })

  const kept = (await listBackups(destination, 'notes')).map((backup) =>
    backup.path.slice(-19, -9)
  )
  assert.deepEqual(kept, [
    // daily
    '2026-03-01',
    '2026-02-28',
    '2026-02-27',
    '2026-02-26',
    '2026-02-25',
    '2026-02-24',
    '2026-02-23',
    // weekly (the newest of each week, weeks start on Monday)
    '2026-02-22',
    '2026-02-15',
    '2026-02-08',
    // monthly
    '2026-01-31'
  ])
  assert.equal(removed.length, 61 - 11)
})

test('keep.last keeps the newest backups', async () => {
  for (let day = 1; day <= 5; day++) fakeBackup(new Date(2026, 0, day))
  const removed = await rotateBackups({
    destination,
    prefix: 'notes',
    keep: { last: 2 }
  })
  assert.equal(removed.length, 3)
  assert.equal((await listBackups(destination, 'notes')).length, 2)
})

test('always keeps the newest backup', async () => {
  for (let day = 1; day <= 3; day++) fakeBackup(new Date(2026, 0, day))
  await rotateBackups({ destination, prefix: 'notes', keep: {} })
  const list = await listBackups(destination, 'notes')
  assert.equal(list.length, 1)
  assert.deepEqual(list[0].date, new Date(2026, 0, 3))
})

test('backupFolder removes old backups', async () => {
  fakeBackup(new Date(2020, 0, 1))
  fakeBackup(new Date(2020, 0, 2))
  const { removed } = await backupFolder({
    source,
    destination,
    keep: { last: 2 }
  })
  assert.equal(removed.length, 1)
  assert.match(removed[0], /notes_2020-01-01/)
})

test('throws on invalid input', async () => {
  await assert.rejects(
    backupFolder({ source: join(root, 'missing'), destination }),
    /ENOENT/
  )
  await assert.rejects(
    backupFolder({ source, destination, keep: { daily: -1 } }),
    RangeError
  )
})

test('scheduleBackups runs repeatedly until stopped', async () => {
  const results = []
  const schedule = scheduleBackups({
    source,
    destination,
    interval: 30,
    keep: { last: 10 },
    onBackup: (result) => results.push(result)
  })
  await new Promise((resolve) => setTimeout(resolve, 200))
  schedule.stop()
  const count = results.length
  assert.ok(count >= 2, `ran ${count} times`)

  await new Promise((resolve) => setTimeout(resolve, 100))
  assert.equal(results.length, count)
})

test('scheduleBackups passes errors to onError', async () => {
  const errors = []
  const schedule = scheduleBackups({
    source: join(root, 'missing'),
    destination,
    onError: (error) => errors.push(error)
  })
  await new Promise((resolve) => setTimeout(resolve, 50))
  schedule.stop()
  assert.equal(errors.length, 1)
})

test('CommonJS build works', async () => {
  const cjs = createRequire(import.meta.url)('../dist/index.cjs')
  const { path } = await cjs.backupFolder({ source, destination })
  assert.equal(readFileSync(join(path, 'a.txt'), 'utf8'), 'hello')
})
