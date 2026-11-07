import { cp, mkdir, readdir, rename, rm, stat } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'

export interface KeepOptions {
  /** Keep the newest N backups. */
  last?: number
  /** Keep the newest backup of each of the last N days that have backups. */
  daily?: number
  /** Same as `daily`, for weeks starting on Monday. */
  weekly?: number
  /** Same as `daily`, for months. */
  monthly?: number
}

export interface RotateOptions {
  /** Folder that holds the backups. */
  destination: string
  /** Start of each backup folder name. */
  prefix: string
  /**
   * Which backups to keep. The newest backup is always kept.
   * Default: `{ daily: 7, weekly: 4, monthly: 12 }`.
   */
  keep?: KeepOptions
}

export interface BackupOptions {
  /** Folder to back up. */
  source: string
  /** Folder to put the backups in. Created if it doesn't exist. */
  destination: string
  /**
   * Start of each backup folder name. Default: the name of the source
   * folder.
   */
  prefix?: string
  /** File and folder names to leave out, for example `node_modules`. */
  skip?: string[]
  /** See `RotateOptions.keep`. */
  keep?: KeepOptions
}

export interface ScheduleOptions extends BackupOptions {
  /** Milliseconds between backups. Default: one day. */
  interval?: number
  /** Called after each backup. */
  onBackup?: (result: BackupResult) => void
  /** Called when a backup fails. Default: `console.error`. */
  onError?: (error: unknown) => void
}

export interface Backup {
  path: string
  /** Date from the folder name. */
  date: Date
}

export interface BackupResult {
  /** Path of the new backup. */
  path: string
  /** Paths of the old backups that were removed. */
  removed: string[]
}

const DEFAULT_KEEP: KeepOptions = { daily: 7, weekly: 4, monthly: 12 }
const DAY = 24 * 60 * 60 * 1000

function pad(value: number): string {
  return String(value).padStart(2, '0')
}

function formatDate(date: Date): string {
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `_${pad(date.getHours())}-${pad(date.getMinutes())}-${pad(date.getSeconds())}`
  )
}

function dayKey(date: Date): string {
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`
}

function weekKey(date: Date): string {
  // The Monday of the week.
  const daysSinceMonday = (date.getDay() + 6) % 7
  return dayKey(
    new Date(
      date.getFullYear(),
      date.getMonth(),
      date.getDate() - daysSinceMonday
    )
  )
}

function monthKey(date: Date): string {
  return `${date.getFullYear()}-${date.getMonth()}`
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function validateKeep(keep: KeepOptions): void {
  for (const [key, value] of Object.entries(keep)) {
    if (value !== undefined && !(Number.isInteger(value) && value >= 0)) {
      throw new RangeError(
        `"keep.${key}" must be an integer >= 0, got ${value}`
      )
    }
  }
}

/**
 * Returns the backups in `destination` whose names start with `prefix`,
 * newest first.
 */
export async function listBackups(
  destination: string,
  prefix: string
): Promise<Backup[]> {
  const pattern = new RegExp(
    `^${escapeRegExp(prefix)}_(\\d{4})-(\\d{2})-(\\d{2})_(\\d{2})-(\\d{2})-(\\d{2})(?:_(\\d+))?$`
  )

  let names: string[]
  try {
    names = await readdir(destination)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }

  const backups: (Backup & { order: number })[] = []
  for (const name of names) {
    const match = pattern.exec(name)
    if (!match) continue
    const [year, month, day, hours, minutes, seconds, order] = match
      .slice(1)
      .map(Number)
    backups.push({
      path: join(destination, name),
      date: new Date(year, month - 1, day, hours, minutes, seconds),
      order: order || 1
    })
  }

  return backups
    .sort((a, b) => b.date.getTime() - a.date.getTime() || b.order - a.order)
    .map(({ path, date }) => ({ path, date }))
}

/**
 * Removes the backups that `keep` doesn't cover. Returns the removed paths.
 */
export async function rotateBackups(options: RotateOptions): Promise<string[]> {
  const { destination, prefix, keep = DEFAULT_KEEP } = options
  validateKeep(keep)

  const backups = await listBackups(destination, prefix)
  const kept = new Set<Backup>(backups.slice(0, Math.max(1, keep.last ?? 0)))

  const rules: [number | undefined, (date: Date) => string][] = [
    [keep.daily, dayKey],
    [keep.weekly, weekKey],
    [keep.monthly, monthKey]
  ]
  for (const [count = 0, getKey] of rules) {
    const seen = new Set<string>()
    // Backups are sorted newest first, so the first one of each period is
    // the newest in that period.
    for (const backup of backups) {
      if (seen.size >= count) break
      const key = getKey(backup.date)
      if (seen.has(key)) continue
      seen.add(key)
      kept.add(backup)
    }
  }

  const removed: string[] = []
  for (const backup of backups) {
    if (kept.has(backup)) continue
    await rm(backup.path, { recursive: true, force: true })
    removed.push(backup.path)
  }
  return removed
}

/**
 * Copies `source` into a new folder in `destination` named
 * `<prefix>_<YYYY-MM-DD_HH-mm-ss>`, then removes old backups.
 */
export async function backupFolder(
  options: BackupOptions
): Promise<BackupResult> {
  const source = resolve(options.source)
  const destination = resolve(options.destination)
  const { prefix = basename(source), skip = [], keep = DEFAULT_KEEP } = options
  validateKeep(keep)

  if (!(await stat(source)).isDirectory()) {
    throw new Error(`"source" is not a folder: ${source}`)
  }
  await mkdir(destination, { recursive: true })

  // Add _2, _3 ... when a backup was already made in the same second.
  const base = `${prefix}_${formatDate(new Date())}`
  const existing = new Set(await readdir(destination))
  let name = base
  for (let i = 2; existing.has(name); i++) name = `${base}_${i}`

  const path = join(destination, name)
  // Copy into a hidden folder first, so a backup that fails half way is
  // never mistaken for a full one.
  const partial = join(destination, `.${name}.partial`)
  const skipSet = new Set(skip)

  try {
    await cp(source, partial, {
      recursive: true,
      errorOnExist: true,
      force: false,
      preserveTimestamps: true,
      filter: (src) => src === source || !skipSet.has(basename(src))
    })
    await rename(partial, path)
  } catch (error) {
    await rm(partial, { recursive: true, force: true })
    throw error
  }

  const removed = await rotateBackups({ destination, prefix, keep })
  return { path, removed }
}

/**
 * Makes a backup right away and then every `interval` milliseconds. Call
 * `stop()` to stop. Errors are passed to `onError`, the next backup still
 * runs.
 */
export function scheduleBackups(options: ScheduleOptions): {
  stop: () => void
} {
  const {
    interval = DAY,
    onBackup,
    onError = (error) => console.error(error),
    ...backupOptions
  } = options
  if (!(interval > 0)) {
    throw new RangeError(
      `"interval" must be a positive number, got ${interval}`
    )
  }

  let stopped = false
  let timer: NodeJS.Timeout | undefined

  const run = async () => {
    try {
      const result = await backupFolder(backupOptions)
      if (!stopped) onBackup?.(result)
    } catch (error) {
      if (!stopped) onError(error)
    }
    // The next backup starts `interval` ms after this one ends, so two
    // backups never run at the same time.
    if (!stopped) timer = setTimeout(run, interval)
  }
  void run()

  return {
    stop: () => {
      stopped = true
      clearTimeout(timer)
    }
  }
}
