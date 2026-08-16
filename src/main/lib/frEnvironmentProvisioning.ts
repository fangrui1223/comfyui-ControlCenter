import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import {
  FR_LAYOUT_PLAN_VERSION,
  type FrLayoutAction,
  type FrLayoutExecutionResult,
  type FrLayoutPlan,
  type FrLayoutTargetKind,
  type FrLayoutTargetPlan,
  type FrPathSnapshot,
  type FrPreflightCheck
} from '../../shared/frEnvironmentProvisioning'
import { configDir } from './paths'
import { writeFileSafe } from './safe-file'

const OWNER_DIR = '.fr-control-center'
const OWNER_FILE = 'ownership.json'
const MIN_FREE_BYTES = 20 * 1024 * 1024 * 1024
const PLAN_TTL_MS = 15 * 60 * 1000

export interface FrLayoutRoots {
  stableRoot: string
  sharedModelsRoot: string
  nextRoot: string
  labRoot: string
  cacheRoot: string
}

export const DEFAULT_FR_LAYOUT_ROOTS: FrLayoutRoots = {
  stableRoot: 'C:\\FR_comfyui',
  sharedModelsRoot: 'C:\\FR_comfyui\\models',
  nextRoot: 'C:\\FR_comfyui_next',
  labRoot: 'C:\\FR_comfyui_lab',
  cacheRoot: 'C:\\FR_comfyui_cache'
}

interface OwnerMarker {
  schemaVersion: 1
  product: 'FR ComfyUI Control Center'
  kind: FrLayoutTargetKind
  state: 'prepared'
  createdAt: string
  transactionId: string
}

interface Journal {
  schemaVersion: 1
  transactionId: string
  planDigest: string
  status: 'executing' | 'committed' | 'rolled-back' | 'failed'
  startedAt: string
  finishedAt: string | null
  createdRoots: string[]
  error?: string
}

function canonical(input: string): string {
  const resolved = path.resolve(input)
  return process.platform === 'win32' ? resolved.toLocaleLowerCase('en-US') : resolved
}

function isSameOrDescendant(candidate: string, parent: string): boolean {
  const candidateKey = canonical(candidate)
  const parentKey = canonical(parent)
  return candidateKey === parentKey || candidateKey.startsWith(parentKey + path.sep)
}

function ownerFile(root: string): string {
  return path.join(root, OWNER_DIR, OWNER_FILE)
}

function readOwner(root: string): OwnerMarker | null {
  try {
    const value = JSON.parse(fs.readFileSync(ownerFile(root), 'utf8')) as Partial<OwnerMarker>
    if (
      value.schemaVersion === 1 &&
      value.product === 'FR ComfyUI Control Center' &&
      (value.kind === 'next' || value.kind === 'lab' || value.kind === 'cache') &&
      value.state === 'prepared'
    ) {
      return value as OwnerMarker
    }
  } catch {
    // Missing, unreadable and invalid markers are all treated as not owned.
  }
  return null
}

function nearestExistingParent(input: string): string | null {
  let cursor = path.resolve(input)
  while (true) {
    try {
      if (fs.statSync(cursor).isDirectory()) return cursor
      return null
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return null
      const parent = path.dirname(cursor)
      if (parent === cursor) return null
      cursor = parent
    }
  }
}

function freeBytesAt(input: string): number | null {
  const parent = nearestExistingParent(input)
  if (!parent) return null
  try {
    const stats = fs.statfsSync(parent)
    return stats.bavail * stats.bsize
  } catch {
    return null
  }
}

function inspectPath(input: string): FrPathSnapshot {
  const freeBytes = freeBytesAt(input)
  try {
    const stat = fs.lstatSync(input)
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      return { path: input, state: 'occupied', freeBytes, ownerRole: null }
    }
    const entries = fs.readdirSync(input)
    if (entries.length === 0) {
      return { path: input, state: 'empty-directory', freeBytes, ownerRole: null }
    }
    const owner = readOwner(input)
    if (owner) {
      return { path: input, state: 'owned-directory', freeBytes, ownerRole: owner.kind }
    }
    return { path: input, state: 'occupied', freeBytes, ownerRole: null }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT') return { path: input, state: 'missing', freeBytes, ownerRole: null }
    return {
      path: input,
      state: 'inaccessible',
      freeBytes,
      ownerRole: null,
      detail: error instanceof Error ? error.message : String(error)
    }
  }
}

function targetDirectories(kind: FrLayoutTargetKind): string[] {
  if (kind === 'cache') {
    return [
      OWNER_DIR,
      path.join(OWNER_DIR, 'transactions'),
      'catalogs',
      'downloads',
      'logs',
      'probes',
      'wheels'
    ]
  }
  return [
    OWNER_DIR,
    path.join(OWNER_DIR, 'compiled-cache'),
    path.join(OWNER_DIR, 'logs'),
    path.join(OWNER_DIR, 'snapshots'),
    path.join(OWNER_DIR, 'staging'),
    path.join(OWNER_DIR, 'transactions')
  ]
}

function targetActions(
  kind: FrLayoutTargetKind,
  root: string,
  transactionId: string,
  snapshot: FrPathSnapshot
): { stagingRoot: string | null; actions: FrLayoutAction[] } {
  if (snapshot.state === 'owned-directory') return { stagingRoot: null, actions: [] }
  const stagingRoot = `${root}.fr-stage-${transactionId}`
  const actions: FrLayoutAction[] = [
    {
      kind: 'create-directory',
      target: stagingRoot,
      description: `Create isolated ${kind} staging layout`,
      reversible: true
    },
    {
      kind: 'write-owner-marker',
      target: ownerFile(stagingRoot),
      description: 'Write FR ownership and prepared-state marker',
      reversible: true
    },
    {
      kind: 'atomic-rename',
      target: root,
      description: 'Atomically publish the prepared layout',
      reversible: true
    }
  ]
  return { stagingRoot, actions }
}

function digestPlan(plan: Omit<FrLayoutPlan, 'planDigest'>): string {
  return crypto.createHash('sha256').update(JSON.stringify(plan)).digest('hex')
}

function uniqueTransactionId(now = new Date()): string {
  const stamp = now
    .toISOString()
    .replace(/[-:.TZ]/g, '')
    .slice(0, 14)
  return `${stamp}-${crypto.randomBytes(4).toString('hex')}`
}

function blockedCheck(id: string, summary: string, detail?: string): FrPreflightCheck {
  return { id, status: 'blocked', summary, detail }
}

function planTarget(
  kind: FrLayoutTargetKind,
  root: string,
  transactionId: string
): FrLayoutTargetPlan {
  const snapshot = inspectPath(root)
  const { stagingRoot, actions } = targetActions(kind, root, transactionId, snapshot)
  return {
    kind,
    root: path.resolve(root),
    stagingRoot,
    directories: targetDirectories(kind),
    snapshot,
    actions
  }
}

/**
 * Read-only preflight. It never creates a target, marker, link or registry entry.
 */
export function buildFrLayoutPlan(
  roots: FrLayoutRoots = DEFAULT_FR_LAYOUT_ROOTS,
  now = new Date()
): FrLayoutPlan {
  const transactionId = uniqueTransactionId(now)
  const checks: FrPreflightCheck[] = []
  const namedRoots: Array<[string, string]> = [
    ['stable', roots.stableRoot],
    ['shared-models', roots.sharedModelsRoot],
    ['next', roots.nextRoot],
    ['lab', roots.labRoot],
    ['cache', roots.cacheRoot]
  ]

  for (const [name, root] of namedRoots) {
    if (!path.isAbsolute(root))
      checks.push(blockedCheck(`absolute-${name}`, `${name} path is not absolute`, root))
  }

  const managedRoots: Array<[FrLayoutTargetKind, string]> = [
    ['next', roots.nextRoot],
    ['lab', roots.labRoot],
    ['cache', roots.cacheRoot]
  ]
  for (let index = 0; index < managedRoots.length; index++) {
    const [kind, root] = managedRoots[index]!
    if (
      isSameOrDescendant(root, roots.stableRoot) ||
      isSameOrDescendant(roots.stableRoot, root) ||
      isSameOrDescendant(root, roots.sharedModelsRoot) ||
      isSameOrDescendant(roots.sharedModelsRoot, root)
    ) {
      checks.push(
        blockedCheck(`protected-${kind}`, `${kind} overlaps a protected stable/model path`, root)
      )
    }
    for (let otherIndex = index + 1; otherIndex < managedRoots.length; otherIndex++) {
      const [otherKind, otherRoot] = managedRoots[otherIndex]!
      if (isSameOrDescendant(root, otherRoot) || isSameOrDescendant(otherRoot, root)) {
        checks.push(
          blockedCheck(`collision-${kind}-${otherKind}`, `${kind} and ${otherKind} paths overlap`)
        )
      }
    }
  }

  const targets = managedRoots.map(([kind, root]) => planTarget(kind, root, transactionId))
  for (const target of targets) {
    const { snapshot } = target
    if (snapshot.state === 'occupied') {
      checks.push(
        blockedCheck(
          `occupied-${target.kind}`,
          `${target.kind} path contains unowned data`,
          target.root
        )
      )
    } else if (snapshot.state === 'empty-directory') {
      checks.push(
        blockedCheck(
          `empty-${target.kind}`,
          `${target.kind} path already exists without an FR ownership marker`,
          'Atomic preparation will not adopt or delete even an empty user-created directory'
        )
      )
    } else if (snapshot.state === 'inaccessible') {
      checks.push(
        blockedCheck(
          `access-${target.kind}`,
          `${target.kind} path cannot be inspected`,
          snapshot.detail
        )
      )
    } else if (snapshot.state === 'owned-directory' && snapshot.ownerRole !== target.kind) {
      checks.push(
        blockedCheck(`owner-${target.kind}`, `${target.kind} path is owned by another FR role`)
      )
    } else {
      checks.push({
        id: `path-${target.kind}`,
        status: 'pass',
        summary:
          snapshot.state === 'owned-directory'
            ? `${target.kind} layout is already prepared`
            : `${target.kind} path is available for atomic preparation`
      })
    }
    if (snapshot.freeBytes === null) {
      checks.push({
        id: `disk-${target.kind}`,
        status: 'warning',
        summary: `Free space for ${target.kind} could not be measured`
      })
    } else if (snapshot.freeBytes < MIN_FREE_BYTES) {
      checks.push(blockedCheck(`disk-${target.kind}`, `${target.kind} has less than 20 GiB free`))
    } else {
      checks.push({
        id: `disk-${target.kind}`,
        status: 'pass',
        summary: `${target.kind} has at least 20 GiB free`
      })
    }
  }

  checks.push({
    id: 'shared-models-read-only',
    status: 'pass',
    summary: 'Shared model library is referenced read-only; M2 performs no scan or write'
  })
  const createdAt = now.toISOString()
  const unsigned: Omit<FrLayoutPlan, 'planDigest'> = {
    version: FR_LAYOUT_PLAN_VERSION,
    transactionId,
    createdAt,
    expiresAt: new Date(now.getTime() + PLAN_TTL_MS).toISOString(),
    mode: 'dry-run',
    stableRoot: path.resolve(roots.stableRoot),
    sharedModelsRoot: path.resolve(roots.sharedModelsRoot),
    targets,
    checks,
    blocked: checks.some((check) => check.status === 'blocked')
  }
  return { ...unsigned, planDigest: digestPlan(unsigned) }
}

function verifyPlan(plan: FrLayoutPlan, now: Date): void {
  if (plan.version !== FR_LAYOUT_PLAN_VERSION || plan.mode !== 'dry-run') {
    throw new Error('Unsupported FR layout plan')
  }
  const { planDigest: _digest, ...unsigned } = plan
  if (digestPlan(unsigned) !== plan.planDigest)
    throw new Error('FR layout plan digest does not match')
  if (plan.blocked) throw new Error('FR layout plan is blocked')
  if (Date.parse(plan.expiresAt) < now.getTime()) throw new Error('FR layout plan has expired')
  for (const target of plan.targets) {
    const current = inspectPath(target.root)
    if (
      current.state !== target.snapshot.state ||
      current.ownerRole !== target.snapshot.ownerRole
    ) {
      throw new Error(`FR layout target changed after dry-run: ${target.root}`)
    }
  }
}

function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n', { encoding: 'utf8', flag: 'wx' })
}

function writeJournal(file: string, journal: Journal): void {
  writeFileSafe(file, JSON.stringify(journal, null, 2) + '\n', { backup: true })
}

function safeRollbackRoot(root: string, transactionId: string): void {
  const owner = readOwner(root)
  if (owner?.transactionId !== transactionId || owner.state !== 'prepared') return
  fs.rmSync(root, { recursive: true, force: true })
}

/** Execute an unexpired, unchanged dry-run plan. Only newly created FR-owned roots are rollback targets. */
export function executeFrLayoutPlan(plan: FrLayoutPlan, now = new Date()): FrLayoutExecutionResult {
  verifyPlan(plan, now)
  const journalDir = path.join(configDir(), 'transactions', 'environment-layout')
  fs.mkdirSync(journalDir, { recursive: true })
  const journalPath = path.join(journalDir, `${plan.transactionId}.json`)
  const journal: Journal = {
    schemaVersion: 1,
    transactionId: plan.transactionId,
    planDigest: plan.planDigest,
    status: 'executing',
    startedAt: now.toISOString(),
    finishedAt: null,
    createdRoots: []
  }
  writeJournal(journalPath, journal)

  try {
    for (const target of plan.targets) {
      if (target.snapshot.state === 'owned-directory') continue
      if (target.snapshot.state === 'empty-directory') {
        // Empty directories cannot be atomically replaced without deleting a
        // user-created object, so execution intentionally refuses them.
        throw new Error(`Target became an existing empty directory: ${target.root}`)
      }
      const stage = target.stagingRoot
      if (!stage) throw new Error(`Missing staging path for ${target.root}`)
      if (fs.existsSync(stage)) throw new Error(`Staging path already exists: ${stage}`)
      fs.mkdirSync(stage, { recursive: false })
      try {
        for (const relative of target.directories)
          fs.mkdirSync(path.join(stage, relative), { recursive: true })
        const marker: OwnerMarker = {
          schemaVersion: 1,
          product: 'FR ComfyUI Control Center',
          kind: target.kind,
          state: 'prepared',
          createdAt: now.toISOString(),
          transactionId: plan.transactionId
        }
        writeJson(ownerFile(stage), marker)
        fs.renameSync(stage, target.root)
        journal.createdRoots.push(target.root)
        writeJournal(journalPath, journal)
      } catch (error) {
        if (fs.existsSync(stage)) fs.rmSync(stage, { recursive: true, force: true })
        throw error
      }
    }
    journal.status = 'committed'
    journal.finishedAt = new Date().toISOString()
    writeJournal(journalPath, journal)
    return {
      transactionId: plan.transactionId,
      status: 'committed',
      startedAt: journal.startedAt,
      finishedAt: journal.finishedAt,
      createdRoots: [...journal.createdRoots],
      journalPath
    }
  } catch (error) {
    for (const root of [...journal.createdRoots].reverse())
      safeRollbackRoot(root, plan.transactionId)
    journal.status = journal.createdRoots.length > 0 ? 'rolled-back' : 'failed'
    journal.error = error instanceof Error ? error.message : String(error)
    journal.finishedAt = new Date().toISOString()
    writeJournal(journalPath, journal)
    return {
      transactionId: plan.transactionId,
      status: journal.status,
      startedAt: journal.startedAt,
      finishedAt: journal.finishedAt,
      createdRoots: [...journal.createdRoots],
      journalPath,
      error: journal.error
    }
  }
}

export const __testing = {
  OWNER_DIR,
  OWNER_FILE,
  MIN_FREE_BYTES,
  canonical,
  digestPlan,
  inspectPath,
  isSameOrDescendant,
  ownerFile,
  targetDirectories
}
