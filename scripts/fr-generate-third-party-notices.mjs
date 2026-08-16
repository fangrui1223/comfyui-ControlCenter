import crypto from 'node:crypto'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const packageJson = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'))
const lockfile = fs.readFileSync(path.join(repoRoot, 'pnpm-lock.yaml'))
const corepackEntry = path.join(
  path.dirname(process.execPath),
  'node_modules',
  'corepack',
  'dist',
  'corepack.js'
)
if (!fs.existsSync(corepackEntry)) {
  throw new Error(`Corepack entry point not found: ${corepackEntry}`)
}
const raw = execFileSync(
  process.execPath,
  [corepackEntry, 'pnpm', 'licenses', 'list', '--prod', '--json'],
  {
  cwd: repoRoot,
  encoding: 'utf8',
  maxBuffer: 16 * 1024 * 1024
  }
)
const grouped = JSON.parse(raw)

const licenses = Object.entries(grouped)
  .sort(([left], [right]) => left.localeCompare(right))
  .map(([license, entries]) => ({
    license,
    packages: entries
      .map((entry) => ({
        name: entry.name,
        versions: [...entry.versions].sort(),
        homepage: entry.homepage ?? null
      }))
      .sort((left, right) =>
        `${left.name}@${left.versions.join(',')}`.localeCompare(
          `${right.name}@${right.versions.join(',')}`
        )
      )
  }))

const output = {
  schemaVersion: 1,
  product: {
    name: packageJson.name,
    version: packageJson.version
  },
  generatedFrom: 'pnpm licenses list --prod --json',
  lockfileSha256: crypto.createHash('sha256').update(lockfile).digest('hex'),
  scope: 'production npm dependency inventory',
  notice:
    'This generated inventory supplements, but does not replace, package license files and independent release legal review.',
  licenses
}

const outputPath = path.join(repoRoot, 'resources', 'THIRD_PARTY_NOTICES.generated.json')
fs.writeFileSync(outputPath, `${JSON.stringify(output, null, 2)}\n`, 'utf8')
console.log(`Wrote ${path.relative(repoRoot, outputPath)} with ${licenses.length} license groups.`)
