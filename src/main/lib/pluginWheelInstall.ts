import fs from 'node:fs'
import crypto from 'node:crypto'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import type { InstallationRecord } from '../installations'
import type { PluginCompatibilityPlan } from '../../types/ipc'
import { getActivePythonPath, getActiveUvPath } from './pythonEnv'
import { download } from './download'
import { fileSha256 } from './pluginSourceManifest'
import { isProtectedDependency } from './pluginDependencyPolicy'
import { runLoggedProcess } from './logged-process'
import { assertPluginPath } from './pluginFilesystem'

export async function prepareApprovedWheels(
  installation: InstallationRecord,
  plan: PluginCompatibilityPlan
): Promise<string> {
  const changes = plan.packageChanges ?? []
  if (!changes.length || plan.executionMode !== 'wheel-update')
    throw new Error('No approved wheel installation plan.')
  const cache = path.join(installation.installPath, '.launcher', 'plugin-wheel-cache')
  await assertPluginPath(installation.installPath, cache)
  await fs.promises.mkdir(cache, { recursive: true })
  const realInstall = await fs.promises.realpath(installation.installPath)
  const realCache = await fs.promises.realpath(cache)
  if (!realCache.startsWith(realInstall + path.sep))
    throw new Error('Wheel cache escaped the installation.')
  const requirements: string[] = []
  for (const change of changes) {
    const wheel = change.wheel
    const url = new URL(wheel.url)
    if (
      isProtectedDependency(change.name) ||
      change.kind === 'removed' ||
      url.protocol !== 'https:' ||
      url.hostname !== 'files.pythonhosted.org' ||
      url.username ||
      url.password ||
      wheel.filename !== path.basename(wheel.filename) ||
      /[\\/\r\n\0]/.test(wheel.filename) ||
      !wheel.filename.endsWith('.whl') ||
      !/^[a-f0-9]{64}$/.test(wheel.sha256)
    )
      throw new Error('The wheel update plan requires separate review.')
    const destination = path.join(cache, wheel.sha256, wheel.filename)
    await assertPluginPath(installation.installPath, destination)
    await fs.promises.mkdir(path.dirname(destination), { recursive: true })
    if (
      (await fs.promises.lstat(path.dirname(destination))).isSymbolicLink() ||
      (fs.existsSync(destination) && (await fs.promises.lstat(destination)).isSymbolicLink())
    )
      throw new Error('Wheel cache contains a link requiring review.')
    if (!fs.existsSync(destination) || (await fileSha256(destination)) !== wheel.sha256) {
      const partial = destination + `.${crypto.randomUUID()}.partial`
      await download(wheel.url, partial, null)
      if ((await fileSha256(partial)) !== wheel.sha256) {
        await fs.promises.rm(partial, { force: true })
        throw new Error(`Wheel hash verification failed: ${change.name}`)
      }
      await fs.promises.rename(partial, destination)
    }
    requirements.push(
      `${change.name} @ ${pathToFileURL(destination).href} --hash=sha256:${wheel.sha256}`
    )
  }
  const lockedRequirements = path.join(cache, `${plan.planDigest}.txt`)
  if (!/^[a-f0-9]{64}$/.test(plan.planDigest)) throw new Error('Invalid package plan digest.')
  await fs.promises.writeFile(lockedRequirements, requirements.join('\n') + '\n', 'utf-8')
  return lockedRequirements
}

export async function installApprovedWheels(
  installation: InstallationRecord,
  requirements: string,
  sendOutput: (text: string) => void
): Promise<void> {
  const python = getActivePythonPath(installation)
  if (!python) throw new Error('The active Python environment was not found.')
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith('UV_') && !key.startsWith('PIP_'))
  )
  const result = await runLoggedProcess(
    getActiveUvPath(installation),
    [
      '--no-config',
      'pip',
      'install',
      '--python',
      python,
      '--offline',
      '--no-index',
      '--no-deps',
      '--no-build',
      '--no-python-downloads',
      '--link-mode',
      'copy',
      '--cache-dir',
      path.join(installation.installPath, '.launcher', 'plugin-wheel-cache', 'uv-cache'),
      '--require-hashes',
      '-r',
      requirements
    ],
    {
      cwd: installation.installPath,
      env: { ...env, UV_PYTHON_DOWNLOADS: 'never' },
      sendOutput
    }
  )
  if (result.exitCode !== 0)
    throw new Error(`Approved dependency installation failed.\n${result.stderr || result.stdout}`)
}
