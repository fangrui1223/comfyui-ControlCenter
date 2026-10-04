import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

export async function fileSha256(filePath: string): Promise<string> {
  const hash = crypto.createHash('sha256')
  for await (const chunk of fs.createReadStream(filePath)) hash.update(chunk)
  return hash.digest('hex')
}

export async function pluginSourceManifest(
  root: string
): Promise<Array<{ path: string; sha256: string }>> {
  const files: Array<{ path: string; sha256: string }> = []
  async function walk(directory: string): Promise<void> {
    for (const entry of await fs.promises.readdir(directory, { withFileTypes: true })) {
      if (['.git', '__pycache__', '.tracking'].includes(entry.name)) continue
      const fullPath = path.join(directory, entry.name)
      if (entry.isSymbolicLink())
        throw new Error('Target source contains a link requiring separate review.')
      if (entry.isDirectory()) await walk(fullPath)
      else if (entry.isFile())
        files.push({
          path: path.relative(root, fullPath).split(path.sep).join('/'),
          sha256: await fileSha256(fullPath)
        })
    }
  }
  await walk(root)
  return files.sort((a, b) => a.path.localeCompare(b.path, 'en-US'))
}

export async function verifyPluginSource(
  root: string,
  files: readonly { path: string; sha256: string }[]
): Promise<void> {
  const realRoot = await fs.promises.realpath(root)
  for (const file of files) {
    const destination = path.resolve(realRoot, file.path)
    if (!destination.startsWith(realRoot + path.sep))
      throw new Error('Invalid target source manifest path.')
    const realFile = await fs.promises.realpath(destination)
    if (!realFile.startsWith(realRoot + path.sep) || (await fileSha256(realFile)) !== file.sha256) {
      throw new Error(`Updated source differs from the approved package: ${file.path}`)
    }
  }
}
