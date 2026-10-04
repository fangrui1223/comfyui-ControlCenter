import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { killProcessTree } from './process'
import { assertPluginPath } from './pluginFilesystem'
import type {
  PluginCompatibilityPlan,
  PluginDependencyDeclaration,
  PluginPackageChange
} from '../../types/ipc'
import { getBundledScriptPath } from './bundledScript'
import {
  isCompiledDependency,
  isProtectedDependency,
  normalizePythonPackageName
} from './pluginDependencyPolicy'

export interface PluginDependencyAnalysis {
  current: PluginDependencyDeclaration[]
  target: PluginDependencyDeclaration[]
  issues: string[]
  currentIssues: string[]
  installedPackages: Record<string, string>
  installedRequirements: Record<string, string[]>
  markerEnvironment: Record<string, string>
}

export class DependencyPlanningError extends Error {
  constructor(
    message: string,
    public conflicts: NonNullable<PluginCompatibilityPlan['dependencyConflicts']> = [],
    public details = ''
  ) {
    super(message)
  }
}

export async function runDependencyHelper<T>(
  python: string,
  command: 'analyze' | 'resolve',
  request: unknown,
  uv?: string
): Promise<T> {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'fr-dependency-plan-'))
  try {
    const input = path.join(root, 'request.json')
    const output = path.join(root, 'result.json')
    await fs.promises.writeFile(input, JSON.stringify(request), 'utf-8')
    await new Promise<void>((resolve, reject) => {
      const child = spawn(
        python,
        [
          '-I',
          '-B',
          '-X',
          'utf8',
          getBundledScriptPath('plugin_dependency_plan.py'),
          command,
          '--request',
          input,
          '--output',
          output,
          ...(uv ? ['--uv', uv] : [])
        ],
        {
          cwd: root,
          windowsHide: true,
          detached: process.platform !== 'win32',
          stdio: ['ignore', 'pipe', 'pipe']
        }
      )
      let stderr = ''
      child.stdout.resume()
      child.stderr.on('data', (chunk) => {
        stderr = (stderr + String(chunk)).slice(-100_000)
      })
      child.once('error', (error) => {
        clearTimeout(timer)
        reject(error)
      })
      child.once('close', async (code) => {
        clearTimeout(timer)
        if (code !== 0) {
          try {
            const failure = JSON.parse(await fs.promises.readFile(output, 'utf-8'))
            reject(
              new DependencyPlanningError(
                failure.error || stderr.trim(),
                failure.conflicts ?? [],
                failure.details ?? ''
              )
            )
          } catch {
            reject(new Error(stderr.trim() || 'Dependency planning failed.'))
          }
        } else resolve()
      })
      const timer = setTimeout(
        () => {
          void killProcessTree(child).then(() =>
            reject(new Error('Dependency planning timed out.'))
          )
        },
        command === 'resolve' ? 10 * 60_000 : 60_000
      )
    })
    return JSON.parse(await fs.promises.readFile(output, 'utf-8')) as T
  } finally {
    await fs.promises.rm(root, { recursive: true, force: true })
  }
}

export function classifyDeclarations(
  declarations: PluginDependencyDeclaration[]
): PluginDependencyDeclaration[] {
  return declarations.map((declaration) => ({
    ...declaration,
    compiled: declaration.compiled || isCompiledDependency(declaration.normalizedName),
    protected: isProtectedDependency(declaration.normalizedName)
  }))
}

export async function resolvePluginWheels(
  python: string,
  uv: string,
  analysis: PluginDependencyAnalysis,
  wheelCacheDir?: string
): Promise<PluginPackageChange[]> {
  if (wheelCacheDir) {
    const installation = path.dirname(path.dirname(wheelCacheDir))
    await assertPluginPath(installation, wheelCacheDir)
    await assertPluginPath(installation, path.join(wheelCacheDir, 'uv-cache'))
  }
  const target = analysis.target.filter(
    (item) => item.active !== false && item.normalizedName !== 'python'
  )
  const requirements = target
    .filter((item) => !item.sourceFile.startsWith('installed-metadata:'))
    .map((item) => {
      const extras = item.extras?.length ? `[${item.extras.join(',')}]` : ''
      return `${item.normalizedName}${extras}${item.constraint ?? ''}`
    })
  const result = await runDependencyHelper<{ changes: PluginPackageChange[] }>(
    python,
    'resolve',
    {
      requirements,
      installedPackages: analysis.installedPackages,
      installedRequirements: analysis.installedRequirements,
      markerEnvironment: analysis.markerEnvironment,
      protectedNames: Object.keys(analysis.installedPackages).filter(isProtectedDependency),
      wheelCacheDir
    },
    uv
  )
  return result.changes.map((change) => ({
    ...change,
    name: normalizePythonPackageName(change.name),
    compiled: change.compiled || isCompiledDependency(change.name),
    protected: isProtectedDependency(change.name)
  }))
}
