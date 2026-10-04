import fs from 'node:fs'
import path from 'node:path'

/** Reject directory links before copying, writing or recursively removing plugin transaction data. */
export async function assertPluginPath(installPath: string, target: string): Promise<void> {
  const root = path.resolve(installPath)
  const relative = path.relative(root, path.resolve(target))
  if (
    !relative ||
    relative === '..' ||
    relative.startsWith('..' + path.sep) ||
    path.isAbsolute(relative)
  )
    throw new Error('Plugin transaction path escaped the installation.')
  let current = root
  for (const component of ['', ...relative.split(path.sep)]) {
    current = path.join(current, component)
    try {
      if ((await fs.promises.lstat(current)).isSymbolicLink())
        throw new Error('Plugin transaction path contains a directory link.')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') break
      throw error
    }
  }
}
