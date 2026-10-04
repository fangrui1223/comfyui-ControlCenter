import crypto from 'crypto'
import fs from 'fs'
import path from 'path'
import type { ChildProcess } from 'child_process'

// Keep the actual directory link outside Git's worktree while Git writes models/.
// Never traverse, copy, remove, or write the shared model library. Both the link
// and any directory Git creates are retained by same-volume renames.
const active = new Set<string>()
const children = new Map<string, Set<number>>()
const STATE_DIR = 'fr-model-link-guard'
export function isModelLinkProtected(repoPath: string | undefined): boolean {
  return !!repoPath && active.has(key(repoPath))
}
interface Journal {
  version: 1
  id: string
  repo: string
  ownerPid: number
  linkTarget: string
  resolvedTarget: string
  childPids?: number[]
}

function stat(file: string): fs.Stats | undefined {
  try {
    return fs.lstatSync(file)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

function key(repo: string): string {
  const resolved = path.resolve(repo)
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

function inside(child: string, parent: string): boolean {
  const relative = path.relative(parent, child)
  return (
    !relative ||
    (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
  )
}

function plainDirectory(dir: string): void {
  const info = stat(dir)
  if (!info?.isDirectory() || info.isSymbolicLink()) {
    throw new Error(`Model link protection requires a physical directory: ${dir}`)
  }
}

function locations(repo: string): { root: string; marker: string; models: string } {
  const root = path.join(repo, '.git', STATE_DIR)
  return { root, marker: path.join(root, 'active.json'), models: path.join(repo, 'models') }
}

function checkParents(repo: string, root: string): void {
  plainDirectory(repo)
  // Refuse unsupported worktree/gitdir layouts rather than moving a link without
  // a durable local recovery journal. Ordinary repos without model links no-op.
  plainDirectory(path.join(repo, '.git'))
  if (stat(root)) plainDirectory(root)
}

function readJournal(repo: string): Journal | undefined {
  const { root, marker } = locations(repo)
  const info = stat(marker)
  if (!info) return undefined
  checkParents(repo, root)
  if (!info.isFile() || info.isSymbolicLink() || info.size > 16384) {
    throw new Error(`Invalid model link recovery journal: ${marker}`)
  }
  const value = JSON.parse(fs.readFileSync(marker, 'utf8')) as Journal
  if (
    value.version !== 1 ||
    !/^[a-f0-9-]{36}$/.test(value.id) ||
    typeof value.repo !== 'string' ||
    key(value.repo) !== key(repo) ||
    !Number.isSafeInteger(value.ownerPid) ||
    value.ownerPid <= 0 ||
    (value.childPids !== undefined &&
      (!Array.isArray(value.childPids) ||
        value.childPids.some((pid) => !Number.isSafeInteger(pid) || pid <= 0))) ||
    typeof value.linkTarget !== 'string' ||
    !value.linkTarget ||
    typeof value.resolvedTarget !== 'string' ||
    !path.isAbsolute(value.resolvedTarget) ||
    inside(value.resolvedTarget, repo) ||
    inside(repo, value.resolvedTarget)
  )
    throw new Error(`Invalid model link recovery journal: ${marker}`)
  plainDirectory(path.join(root, value.id))
  return value
}

function matches(file: string, journal: Journal): boolean {
  return !!stat(file)?.isSymbolicLink() && fs.readlinkSync(file) === journal.linkTarget
}

function ensureExited(pid: number): void {
  try {
    process.kill(pid, 0)
    throw new Error(
      `Model directory is in use by process ${pid}. Wait for it to exit before recovery.`
    )
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
  }
}

function writeJournal(repo: string, journal: Journal): void {
  const { root, marker } = locations(repo)
  const temporary = path.join(root, `${crypto.randomUUID()}.tmp`)
  const fd = fs.openSync(temporary, 'wx')
  try {
    fs.writeFileSync(fd, JSON.stringify(journal))
    fs.fsyncSync(fd)
  } finally {
    fs.closeSync(fd)
  }
  fs.renameSync(temporary, marker)
}

/** An orphaned updater must exit before a restarted launcher restores the link. */
export function trackModelLinkChild(repoPath: string | undefined, child: ChildProcess): void {
  if (!repoPath || !child.pid || !active.has(key(repoPath))) return
  const repo = path.resolve(repoPath)
  const identity = key(repo)
  const pid = child.pid
  const running = children.get(identity) ?? new Set<number>()
  children.set(identity, running)
  running.add(pid)
  child.once('close', () => {
    running.delete(pid)
    try {
      const journal = readJournal(repo)
      if (journal) {
        journal.childPids = (journal.childPids ?? []).filter((value) => value !== pid)
        writeJournal(repo, journal)
      }
    } catch (error) {
      // The on-disk PID still prevents early recovery; once it exits the next
      // launch can recover even if this best-effort removal failed.
      console.warn('Could not clear exited model-link updater process:', error)
    }
  })
  try {
    const journal = readJournal(repo)!
    journal.childPids = [...new Set([...(journal.childPids ?? []), pid])]
    writeJournal(repo, journal)
  } catch (error) {
    child.kill()
    throw error
  }
}

function restore(repo: string, sendOutput?: (text: string) => void): boolean {
  const journal = readJournal(repo)
  if (!journal) return false
  for (const pid of new Set([...(journal.childPids ?? []), ...(children.get(key(repo)) ?? [])]))
    ensureExited(pid)
  const { root, models, marker } = locations(repo)
  const history = path.join(root, journal.id)
  const parked = path.join(history, 'original-link')
  const generated = path.join(history, 'checkout-models')
  if (stat(parked)) {
    if (!matches(parked, journal)) throw new Error(`Preserved model link changed: ${parked}`)
    if (stat(models)) {
      plainDirectory(models)
      if (stat(generated)) throw new Error(`Model directory recovery collision: ${generated}`)
      fs.renameSync(models, generated)
    }
    fs.renameSync(parked, models)
  }
  if (!matches(models, journal) || key(fs.realpathSync(models)) !== key(journal.resolvedTarget)) {
    throw new Error(`Could not restore model directory link; recovery data retained at ${history}`)
  }
  fs.writeFileSync(
    path.join(history, 'restored.json'),
    JSON.stringify({ ...journal, restoredAt: Date.now() })
  )
  fs.unlinkSync(marker)
  sendOutput?.('[models] Shared model directory link restored and verified.\n')
  return true
}

/** Recover even when HEAD did not move, or the ordinary source-op marker is gone. */
export function recoverModelLink(repoPath: string, sendOutput?: (text: string) => void): boolean {
  const repo = path.resolve(repoPath)
  if (active.has(key(repo))) throw new Error('A model directory operation is already running.')
  const journal = readJournal(repo)
  if (!journal) return false
  if (journal.ownerPid !== process.pid) {
    ensureExited(journal.ownerPid)
  }
  return restore(repo, sendOutput)
}

/** The callback must settle only after its Git child process has closed. */
export async function withProtectedModelLink<T>(
  repoPath: string,
  operation: (guarded: boolean) => Promise<T>,
  sendOutput?: (text: string) => void
): Promise<T> {
  const repo = path.resolve(repoPath)
  const identity = key(repo)
  if (active.has(identity)) throw new Error('A model directory operation is already running.')
  recoverModelLink(repo, sendOutput)
  const { root, models } = locations(repo)
  if (!stat(models)?.isSymbolicLink()) return operation(false)
  checkParents(repo, root)
  const target = fs.realpathSync(models)
  if (!fs.statSync(models).isDirectory() || inside(target, repo) || inside(repo, target)) {
    throw new Error('Model directory link must point to a separate model library.')
  }
  active.add(identity)
  try {
    fs.mkdirSync(root, { recursive: true })
    const journal: Journal = {
      version: 1,
      id: crypto.randomUUID(),
      repo,
      ownerPid: process.pid,
      linkTarget: fs.readlinkSync(models),
      resolvedTarget: target
    }
    const history = path.join(root, journal.id)
    fs.mkdirSync(history)
    // Commit recovery information BEFORE detaching anything. A malformed or
    // unwritable journal fails closed; a crash at any subsequent rename can be
    // retried without deleting either the shared library or generated files.
    writeJournal(repo, journal)
    try {
      fs.renameSync(models, path.join(history, 'original-link'))
      fs.mkdirSync(models)
      sendOutput?.('[models] Shared model directory link protected during source checkout.\n')
      return await operation(true)
    } finally {
      restore(repo, sendOutput)
    }
  } finally {
    active.delete(identity)
    if (!children.get(identity)?.size) children.delete(identity)
  }
}
