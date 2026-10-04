import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { assertPluginPath } from './pluginFilesystem'

const BACKUP_ROOT = path.join('.launcher', 'plugin-update-backups')

export interface PluginSourceBackupEntry {
  dirName: string
  sourcePath: string
  backupPath: string
}

export interface PluginSourceBackupTransaction {
  root: string
  manifestPath: string
  entries: PluginSourceBackupEntry[]
}

function safeDirName(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= 200 &&
    value === path.basename(value) &&
    value !== '.' &&
    value !== '..' &&
    !/[\\/]/.test(value) &&
    !value.includes('\0')
  )
}

function assertInside(parent: string, child: string): void {
  const parentPath = path.resolve(parent)
  const childPath = path.resolve(child)
  if (childPath !== parentPath && !childPath.startsWith(parentPath + path.sep)) {
    throw new Error(`Plugin backup path escaped its allowed root: ${child}`)
  }
}

async function removeBackupRoot(root: string): Promise<void> {
  await fs.promises.rm(root, { recursive: true, force: true })
  try {
    await fs.promises.rmdir(path.dirname(root))
  } catch {}
}

export async function preparePluginSourceBackups(
  installPath: string,
  comfyuiDir: string,
  dirNames: readonly string[]
): Promise<PluginSourceBackupTransaction | null> {
  const unique = [...new Set(dirNames)]
  if (unique.length === 0) return null

  const transactionId = `${new Date().toISOString().replace(/[:.]/g, '-')}-${crypto.randomUUID()}`
  const rootParent = path.resolve(installPath, BACKUP_ROOT)
  const root = path.join(rootParent, transactionId)
  const customNodesDir = path.resolve(comfyuiDir, 'custom_nodes')
  assertInside(rootParent, root)

  const entries: PluginSourceBackupEntry[] = []
  let created = false
  try {
    await assertPluginPath(installPath, root)
    await fs.promises.mkdir(root, { recursive: true })
    created = true
    for (const dirName of unique) {
      if (!safeDirName(dirName)) throw new Error(`Invalid plugin directory name: ${dirName}`)
      const sourcePath = path.join(customNodesDir, dirName)
      const backupPath = path.join(root, dirName)
      assertInside(customNodesDir, sourcePath)
      assertInside(root, backupPath)
      await assertPluginPath(installPath, sourcePath)
      const stat = await fs.promises.stat(sourcePath)
      if (!stat.isDirectory()) throw new Error(`Plugin directory was not found: ${dirName}`)
      await fs.promises.cp(sourcePath, backupPath, {
        recursive: true,
        force: false,
        errorOnExist: true
      })
      entries.push({ dirName, sourcePath, backupPath })
    }

    const manifestPath = path.join(root, 'transaction.json')
    await fs.promises.writeFile(
      manifestPath,
      JSON.stringify(
        {
          version: 1,
          state: 'prepared',
          createdAt: new Date().toISOString(),
          entries: entries.map(({ dirName, sourcePath, backupPath }) => ({
            dirName,
            sourcePath,
            backupPath
          }))
        },
        null,
        2
      ) + '\n',
      'utf-8'
    )
    return { root, manifestPath, entries }
  } catch (error) {
    if (created) await removeBackupRoot(root).catch(() => {})
    throw error
  }
}

export async function restorePluginSourceBackups(
  transaction: PluginSourceBackupTransaction,
  sendOutput: (text: string) => void,
  retainBackup = false
): Promise<string[]> {
  const errors: string[] = []
  for (const entry of transaction.entries) {
    try {
      const stat = await fs.promises.stat(entry.backupPath)
      if (!stat.isDirectory()) throw new Error('backup directory is missing')
      await fs.promises.rm(entry.sourcePath, { recursive: true, force: true })
      await fs.promises.cp(entry.backupPath, entry.sourcePath, {
        recursive: true,
        force: false,
        errorOnExist: true
      })
      sendOutput(`Restored ${entry.dirName} from the local pre-update backup.\n`)
    } catch (error) {
      errors.push(`${entry.dirName}: ${(error as Error).message}`)
    }
  }

  if (errors.length === 0 && !retainBackup) await removeBackupRoot(transaction.root)
  return errors
}

export async function discardPluginSourceBackups(
  transaction: PluginSourceBackupTransaction | null
): Promise<void> {
  if (!transaction) return
  await removeBackupRoot(transaction.root)
}
