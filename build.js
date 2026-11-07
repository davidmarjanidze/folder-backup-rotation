import { execSync } from 'node:child_process'
import { copyFileSync, rmSync } from 'node:fs'
import { build } from 'esbuild'

rmSync('dist', { recursive: true, force: true })

const options = {
  entryPoints: ['src/index.ts'],
  bundle: true,
  platform: 'node',
  target: 'node18'
}

await Promise.all([
  build({ ...options, format: 'esm', outfile: 'dist/index.js' }),
  build({ ...options, format: 'cjs', outfile: 'dist/index.cjs' })
])

// esbuild doesn't emit type declarations, so tsc handles those.
execSync('tsc', { stdio: 'inherit' })
copyFileSync('dist/index.d.ts', 'dist/index.d.cts')
