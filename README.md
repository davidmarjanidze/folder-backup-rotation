# folder-backup-rotation

[![npm version](https://img.shields.io/npm/v/folder-backup-rotation.svg)](https://www.npmjs.com/package/folder-backup-rotation)
[![license](https://img.shields.io/npm/l/folder-backup-rotation.svg)](https://www.npmjs.com/package/folder-backup-rotation)

Copies a folder into a backup folder and removes old backups, so you keep
recent backups for every day and older ones for every week and month,
without the backup disk filling up.

Works with both `import` and `require`. Requires Node.js 18 or newer. No
dependencies.

## Installation

```console
npm i folder-backup-rotation
```

## Usage

```ts
import { backupFolder } from 'folder-backup-rotation'

const { path, removed } = await backupFolder({
  source: '/Users/me/notes',
  destination: '/Volumes/Backup/notes',
  skip: ['node_modules', '.git']
})
// path: '/Volumes/Backup/notes/notes_2026-11-07_10-30-00'
// removed: paths of old backups that were deleted
```

Each backup is a full copy of the folder named
`<prefix>_<YYYY-MM-DD_HH-mm-ss>`, using local time. The prefix is the name
of the source folder unless you set `prefix`. The copy is first made in a
hidden `.partial` folder and renamed when it's done, so a backup that
fails half way never counts as a real one.

To make a backup every day while the script is running:

```ts
import { scheduleBackups } from 'folder-backup-rotation'

const schedule = scheduleBackups({
  source: '/Users/me/notes',
  destination: '/Volumes/Backup/notes',
  interval: 24 * 60 * 60 * 1000,
  onBackup: ({ path }) => console.log(`Saved ${path}`),
  onError: (error) => console.error('Backup failed', error)
})

// schedule.stop()
```

The first backup is made right away. To make backups when the computer
starts, you can combine it with
[startup-tasks-automation](https://www.npmjs.com/package/startup-tasks-automation)
or run the script from cron.

## Which backups are kept

By default: the newest backup of each of the last 7 days, 4 weeks and 12
months. For example, with one backup a day, after a year you have about 21
backups instead of 365.

```ts
await backupFolder({
  source,
  destination,
  keep: { last: 3, daily: 14, weekly: 8, monthly: 24 }
})
```

- `last` - the newest N backups.
- `daily` - the newest backup of each of the last N days that have a backup.
- `weekly` - same for weeks. Weeks start on Monday.
- `monthly` - same for months.

A backup is kept if any rule keeps it. The newest backup is always kept.
Days without a backup don't count, so if the computer was off for a week you
still keep 7 daily backups.

Only folders that match `<prefix>_<date>` are ever removed. Other files in
the destination are left alone.

## API

### backupFolder(options)

- `options.source` - folder to back up.
- `options.destination` - folder for the backups. Created if needed. It must
  not be inside `source`.
- `options.prefix` - start of the backup folder names. Default: the name of
  `source`.
- `options.skip` - file and folder names to leave out. Default: `[]`.
- `options.keep` - which backups to keep, see above. Default:
  `{ daily: 7, weekly: 4, monthly: 12 }`.
- Returns: `Promise<{ path: string, removed: string[] }>`

### scheduleBackups(options)

Takes the same options as `backupFolder`, plus:

- `options.interval` - milliseconds between the end of one backup and the
  start of the next. Default: one day.
- `options.onBackup` - called with the result of each backup.
- `options.onError` - called when a backup fails. The next one still runs.
  Default: `console.error`.
- Returns: `{ stop() }`

### rotateBackups({ destination, prefix, keep })

Only removes old backups, without making a new one.

- Returns: `Promise<string[]>`, the removed paths.

### listBackups(destination, prefix)

- Returns: `Promise<{ path: string, date: Date }[]>`, newest first.

## License

ISC
