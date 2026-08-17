import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { getWindowsSigningBuilderArgs } from './fr-require-windows-signing.mjs'

function main() {
  const cli = path.resolve('node_modules/electron-builder/cli.js')
  const result = spawnSync(process.execPath, [cli, ...getWindowsSigningBuilderArgs()], {
    cwd: process.cwd(),
    env: process.env,
    stdio: 'inherit'
  })
  if (result.error) throw result.error
  process.exitCode = result.status ?? 1
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : ''
if (invokedPath === fileURLToPath(import.meta.url)) main()
