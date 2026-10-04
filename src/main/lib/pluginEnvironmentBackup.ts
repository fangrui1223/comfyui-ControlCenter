import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import type { InstallationRecord } from '../installations'
import { getActiveVenvDir } from './pythonEnv'
import { assertPluginPath } from './pluginFilesystem'
import {
  discardPluginSourceBackups,
  restorePluginSourceBackups,
  type PluginSourceBackupTransaction
} from './pluginUpdateBackup'

type TransactionState =
  | 'preparing'
  | 'prepared'
  | 'applying-source'
  | 'applying-dependencies'
  | 'validating'
  | 'committed'
  | 'rolled-back'
export interface PluginTransactionJournal {
  version: 1
  root: string
  state: TransactionState
  sourceBackups: PluginSourceBackupTransaction
  environment: { sourcePath: string; backupPath: string; prepared: boolean } | null
  planDigest: string | null
  startedAt: string
}

function journalPath(installPath: string): string {
  return path.join(installPath, '.launcher', 'plugin-update-in-progress.json')
}

function inside(parent: string, child: string): void {
  const relative = path.relative(path.resolve(parent), path.resolve(child))
  if (
    !relative ||
    relative === '..' ||
    relative.startsWith('..' + path.sep) ||
    path.isAbsolute(relative)
  )
    throw new Error('Plugin recovery path escaped its allowed root.')
}

function validateJournal(installPath: string, journal: PluginTransactionJournal): void {
  if (
    journal.version !== 1 ||
    ![
      'preparing',
      'prepared',
      'applying-source',
      'applying-dependencies',
      'validating',
      'committed',
      'rolled-back'
    ].includes(journal.state)
  )
    throw new Error('Invalid plugin recovery journal.')
  inside(path.join(installPath, '.launcher', 'plugin-update-transactions'), journal.root)
  inside(path.join(installPath, '.launcher', 'plugin-update-backups'), journal.sourceBackups.root)
  if (
    journal.sourceBackups.manifestPath !== path.join(journal.sourceBackups.root, 'transaction.json')
  )
    throw new Error('Invalid plugin backup manifest.')
  for (const entry of journal.sourceBackups.entries) {
    if (
      entry.sourcePath !== path.join(installPath, 'ComfyUI', 'custom_nodes', entry.dirName) ||
      entry.dirName !== path.basename(entry.dirName) ||
      /[\\/\0]/.test(entry.dirName) ||
      ['.', '..'].includes(entry.dirName)
    )
      throw new Error('Invalid plugin recovery directory.')
    inside(journal.sourceBackups.root, entry.backupPath)
    if (entry.backupPath !== path.join(journal.sourceBackups.root, entry.dirName))
      throw new Error('Invalid plugin source backup path.')
  }
  if (journal.environment) {
    // The first dependency transaction supports this managed venv only.
    if (
      journal.environment.sourcePath !== path.join(installPath, 'ComfyUI', '.venv') ||
      journal.environment.backupPath !== path.join(journal.root, 'environment')
    )
      throw new Error('Invalid environment recovery directory.')
  }
}

async function assertRealRecoveryPaths(
  installPath: string,
  journal: PluginTransactionJournal
): Promise<void> {
  // Check every existing ancestor before copying or recursively removing a path.
  // A junction in .launcher or custom_nodes must never redirect recovery.
  for (const target of [
    journal.root,
    journal.sourceBackups.root,
    ...journal.sourceBackups.entries.flatMap((entry) => [entry.sourcePath, entry.backupPath]),
    ...(journal.environment ? [journal.environment.sourcePath, journal.environment.backupPath] : [])
  ]) {
    await assertPluginPath(installPath, target)
  }
}

export async function directoryByteSize(root: string): Promise<number> {
  let bytes = 0
  async function walk(directory: string): Promise<void> {
    for (const entry of await fs.promises.readdir(directory, { withFileTypes: true })) {
      const fullPath = path.join(directory, entry.name)
      if (entry.isDirectory()) await walk(fullPath)
      else if (entry.isFile()) bytes += (await fs.promises.stat(fullPath)).size
    }
  }
  await walk(root)
  return bytes
}

export async function writePluginJournal(
  installation: InstallationRecord,
  journal: PluginTransactionJournal,
  state: TransactionState
): Promise<void> {
  validateJournal(installation.installPath, journal)
  await assertRealRecoveryPaths(installation.installPath, journal)
  const target = journalPath(installation.installPath)
  const temporary = `${target}.${crypto.randomUUID()}.tmp`
  journal.state = state
  await fs.promises.mkdir(path.dirname(target), { recursive: true })
  try {
    await fs.promises.writeFile(temporary, JSON.stringify(journal), {
      encoding: 'utf-8',
      flush: true
    })
    await fs.promises.rename(temporary, target)
  } finally {
    await fs.promises.rm(temporary, { force: true }).catch(() => {})
  }
}

export async function beginPluginTransaction(
  installation: InstallationRecord,
  sourceBackups: PluginSourceBackupTransaction,
  planDigest: string | null,
  backupEnvironment: boolean,
  progress?: (percent: number) => void
): Promise<PluginTransactionJournal> {
  if (fs.existsSync(journalPath(installation.installPath)))
    throw new Error('An interrupted plugin update must be recovered before another update.')
  const root = path.join(
    installation.installPath,
    '.launcher',
    'plugin-update-transactions',
    crypto.randomUUID()
  )
  const sourcePath = getActiveVenvDir(installation)
  const journal: PluginTransactionJournal = {
    version: 1,
    root,
    state: 'preparing',
    sourceBackups,
    planDigest,
    environment: backupEnvironment
      ? { sourcePath, backupPath: path.join(root, 'environment'), prepared: false }
      : null,
    startedAt: new Date().toISOString()
  }
  validateJournal(installation.installPath, journal)
  await assertRealRecoveryPaths(installation.installPath, journal)
  await fs.promises.mkdir(root, { recursive: true })
  await writePluginJournal(installation, journal, 'preparing')
  if (journal.environment) {
    const stat = await fs.promises.lstat(sourcePath)
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw new Error('The managed Python environment must be a real directory.')
    const bytes = await directoryByteSize(sourcePath)
    const disk = await fs.promises.statfs(root)
    if (Number(disk.bavail) * Number(disk.bsize) < bytes * 1.2 + 256 * 1024 * 1024)
      throw new Error('Insufficient disk space for the offline environment rollback backup.')
    let visitedBytes = 0
    let lastProgress = 0
    await fs.promises.cp(sourcePath, journal.environment.backupPath, {
      recursive: true,
      force: false,
      errorOnExist: true,
      preserveTimestamps: true,
      verbatimSymlinks: true,
      filter: async (source) => {
        const entry = await fs.promises.lstat(source)
        if (entry.isFile()) visitedBytes += entry.size
        if (Date.now() - lastProgress > 150) {
          progress?.(Math.min(99, bytes ? (visitedBytes / bytes) * 100 : 0))
          lastProgress = Date.now()
        }
        return true
      }
    })
    journal.environment.prepared = true
  }
  await writePluginJournal(installation, journal, 'prepared')
  return journal
}

export async function restorePluginTransaction(
  installation: InstallationRecord,
  journal: PluginTransactionJournal,
  sendOutput: (text: string) => void
): Promise<string[]> {
  validateJournal(installation.installPath, journal)
  await assertRealRecoveryPaths(installation.installPath, journal)
  const errors = await restorePluginSourceBackups(journal.sourceBackups, sendOutput, true)
  if (journal.environment?.prepared) {
    try {
      const { sourcePath, backupPath } = journal.environment
      const backup = await fs.promises.lstat(backupPath)
      if (!backup.isDirectory() || backup.isSymbolicLink())
        throw new Error('Environment rollback backup is missing.')
      inside(installation.installPath, await fs.promises.realpath(path.dirname(sourcePath)))
      inside(journal.root, await fs.promises.realpath(backupPath))
      await fs.promises.rm(sourcePath, { recursive: true, force: true })
      await fs.promises.cp(backupPath, sourcePath, {
        recursive: true,
        force: false,
        errorOnExist: true,
        preserveTimestamps: true,
        verbatimSymlinks: true
      })
      sendOutput('Restored Python environment from the offline backup.\n')
    } catch (error) {
      errors.push(`Environment rollback failed: ${(error as Error).message}`)
    }
  }
  if (!errors.length) await writePluginJournal(installation, journal, 'rolled-back')
  return errors
}

export async function finishPluginTransaction(
  installation: InstallationRecord,
  journal: PluginTransactionJournal,
  committed: boolean
): Promise<void> {
  // Completion is durable before cleanup. A failed cleanup must never undo a
  // successful update or discard the only usable rollback backup.
  await assertRealRecoveryPaths(installation.installPath, journal)
  await writePluginJournal(installation, journal, committed ? 'committed' : 'rolled-back')
  await discardPluginSourceBackups(journal.sourceBackups)
  validateJournal(installation.installPath, journal)
  await fs.promises.rm(journal.root, { recursive: true, force: true })
  await fs.promises.rm(journalPath(installation.installPath), { force: true })
}

export async function recoverInterruptedPluginUpdate(
  installation: InstallationRecord,
  sendOutput: (text: string) => void
): Promise<boolean> {
  const file = journalPath(installation.installPath)
  if (!fs.existsSync(file)) return false
  await assertPluginPath(installation.installPath, file)
  const journal = JSON.parse(await fs.promises.readFile(file, 'utf-8')) as PluginTransactionJournal
  validateJournal(installation.installPath, journal)
  if (['committed', 'rolled-back', 'preparing', 'prepared'].includes(journal.state)) {
    await finishPluginTransaction(installation, journal, journal.state === 'committed')
    return journal.state !== 'committed'
  }
  const errors = await restorePluginTransaction(installation, journal, sendOutput)
  if (errors.length) throw new Error(errors.join('\n'))
  await finishPluginTransaction(installation, journal, false)
  return true
}
