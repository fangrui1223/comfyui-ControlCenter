import fs from 'node:fs'
import { execFileSync } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PluginCompatibilityEnvironment, PluginUpdateItem } from '../../types/ipc'

vi.mock('electron', () => ({ app: { getPath: () => process.cwd() } }))

import {
  buildPluginCompatibilityPlan,
  getApprovedPluginPlan,
  __testing
} from './pluginCompatibility'

const roots: string[] = []

function directory(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fr-plugin-compat-test-'))
  roots.push(root)
  return root
}

function write(root: string, name: string, content: string): void {
  const target = path.join(root, name)
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, content, 'utf-8')
}

function item(overrides: Partial<PluginUpdateItem> = {}): PluginUpdateItem {
  return {
    id: 'compiled-node',
    dirName: 'compiled-node',
    enabled: true,
    sourceType: 'cnr',
    repository: 'https://github.com/example/compiled-node',
    branch: null,
    upstream: null,
    localCommit: null,
    remoteCommit: null,
    installedVersion: '1.0.0',
    latestVersion: '1.1.0',
    ahead: null,
    behind: 1,
    dirty: false,
    status: 'update-available',
    updateable: false,
    reasonCode: 'compiled-dependencies',
    reason: 'Compiled dependencies require a compatibility update.',
    hasRequirements: true,
    hasInstallScript: false,
    hasCompiledDependencies: true,
    ...overrides
  }
}

const environment: PluginCompatibilityEnvironment = {
  pythonVersion: '3.12.10',
  pythonArchitecture: 'AMD64',
  torchVersion: '2.8.0+cu128',
  cudaVersion: 'cu128',
  numpyVersion: '2.2.6',
  compiledPackages: {
    torch: '2.8.0+cu128',
    numpy: '2.2.6',
    'onnxruntime-gpu': '1.22.0'
  }
}

function plan(
  currentRoot: string,
  targetRoot: string,
  overrides: Partial<Parameters<typeof buildPluginCompatibilityPlan>[0]> = {}
) {
  const packages = overrides.installedPackages ?? {
    torch: '2.8.0+cu128',
    numpy: '2.2.6',
    'onnxruntime-gpu': '1.22.0'
  }
  const python = process.env.FR_TEST_PYTHON ?? (process.platform === 'win32' ? 'python' : 'python3')
  const dependencyAnalysis = JSON.parse(
    execFileSync(
      python,
      [
        '-I',
        '-B',
        '-c',
        'import sys,json; sys.path.insert(0,sys.argv[1]); from plugin_dependency_plan import analyze; print(json.dumps(analyze(json.loads(sys.argv[2]))))',
        path.resolve('lib'),
        JSON.stringify({
          currentRoot,
          targetRoot,
          installedPackages: packages,
          installedRequirements: {},
          markerEnvironment: {
            python_full_version: environment.pythonVersion,
            python_version: '3.12',
            sys_platform: 'win32'
          }
        })
      ],
      { encoding: 'utf-8', windowsHide: true }
    )
  )
  return buildPluginCompatibilityPlan({
    dependencyAnalysis,
    installationId: 'inst-1',
    item: item(),
    currentRoot,
    targetRoot,
    targetSource: 'test fixture',
    provenance: 'fixture://compiled-node/1.1.0',
    environment,
    installedPackages: {
      torch: '2.8.0+cu128',
      numpy: '2.2.6',
      'onnxruntime-gpu': '1.22.0'
    },
    preexistingPipCheckIssues: [],
    managerPolicyAllowed: true,
    managerPolicyReason: null,
    ...overrides
  })
}

afterEach(() => {
  __testing.planCache.clear()
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

describe('buildPluginCompatibilityPlan', () => {
  it('keeps unused optional dependency profiles out of a source update and reports them', () => {
    const current = directory()
    const target = directory()
    for (const root of [current, target]) {
      write(root, 'requirements.txt', '# Base nodes use the existing ComfyUI environment\n')
      write(
        root,
        'requirements-prompt-rewriter.txt',
        'transformers<5\nhuggingface-hub<1\npillow<11\ntorch>=99\n'
      )
      write(root, 'repair_dependency_list.txt', '--extra-index-url https://example.org\n')
      write(root, 'pyproject.toml', '[project]\nrequires-python = ">=3.10"\ndependencies = []\n')
    }

    const result = plan(current, target)

    expect(result.verdict).toBe('ready')
    expect(result.executionMode).toBe('source-only')
    expect(result.targetDependencies.map((dependency) => dependency.normalizedName)).toEqual([
      'python'
    ])
    expect(result.dependencyDifferences).toEqual([])
    expect(result.packageChanges).toEqual([])
    expect(result.warnings.join('\n')).toContain('requirements-prompt-rewriter.txt')
    expect(result.warnings.join('\n')).toContain('repair_dependency_list.txt')
  })

  it('still blocks a protected dependency in a profile explicitly included by the base file', () => {
    const current = directory()
    const target = directory()
    write(current, 'requirements.txt', '')
    write(target, 'requirements.txt', '-r requirements-feature.txt\n')
    write(target, 'requirements-feature.txt', 'torch>=99\n')

    const result = plan(current, target)

    expect(result.verdict).toBe('blocked')
    expect(result.blockers.join('\n')).toContain('torch>=99')
    expect(result.warnings.join('\n')).not.toContain('Separate requirement files')
  })

  it('allows a source-only update when compiled declarations and hooks are unchanged', () => {
    const current = directory()
    const target = directory()
    for (const root of [current, target]) {
      write(root, 'requirements.txt', 'onnxruntime-gpu==1.22.0\nnumpy==2.2.6\n')
      write(root, 'install.py', 'print("same hook")\n')
    }

    const result = plan(current, target)

    expect(result.verdict).toBe('ready')
    expect(result.compiledDependencyDifferences).toEqual([])
    expect(result.installHookDifferences).toEqual([{ path: 'install.py', kind: 'unchanged' }])
  })

  it('allows a newly declared compiled dependency already satisfied by the installed environment', () => {
    const current = directory()
    const target = directory()
    write(current, 'requirements.txt', 'numpy==2.2.6\n')
    write(target, 'requirements.txt', 'numpy==2.2.6\nonnxruntime-gpu==1.22.0\n')

    const result = plan(current, target)

    expect(result.verdict).toBe('ready')
    expect(result.compiledDependencyDifferences).toEqual([
      expect.objectContaining({ name: 'onnxruntime-gpu', kind: 'added' })
    ])
  })

  it.each(['torch==2.9.0', 'numpy==2.3.0', 'python>=3.13'])(
    'blocks a protected stack declaration change: %s',
    (requirement) => {
      const current = directory()
      const target = directory()
      write(current, 'requirements.txt', 'numpy==2.2.6\n')
      if (requirement.startsWith('python')) {
        write(target, 'requirements.txt', 'numpy==2.2.6\n')
        write(
          target,
          'pyproject.toml',
          `[project]\nname = "compiled-node"\nversion = "1.1.0"\nrequires-python = ">=3.13"\n`
        )
      } else write(target, 'requirements.txt', `numpy==2.2.6\n${requirement}\n`)

      const result = plan(current, target)

      expect(result.verdict).toBe('blocked')
      expect(result.protectedStackDifferences.length).toBeGreaterThan(0)
    }
  )

  it('routes a missing compiled dependency to a wheel plan rather than assuming source-only is safe', () => {
    const current = directory()
    const target = directory()
    for (const root of [current, target]) {
      write(root, 'requirements.txt', 'insightface==0.7.3\n')
    }

    const result = plan(current, target)

    expect(result.verdict).toBe('review-required')
    expect(result.executionMode).toBe('wheel-update')
  })

  it('reports pre-existing pip issues without treating them as an update blocker', () => {
    const current = directory()
    const target = directory()
    for (const root of [current, target]) {
      write(root, 'requirements.txt', 'onnxruntime-gpu==1.22.0\n')
    }

    const result = plan(current, target, {
      preexistingPipCheckIssues: ['old-package requires missing-package']
    })

    expect(result.verdict).toBe('ready')
    expect(result.preexistingPipCheckIssues).toEqual(['old-package requires missing-package'])
    expect(result.warnings.join('\n')).toContain('Existing pip check issues')
  })

  it('normalizes semantically equivalent requirement clause ordering', () => {
    const current = directory()
    const target = directory()
    write(current, 'requirements.txt', 'onnxruntime-gpu>=1.20,<2\n')
    write(target, 'requirements.txt', 'onnxruntime-gpu < 2, >= 1.20\n')

    const result = plan(current, target)

    expect(result.verdict).toBe('ready')
    expect(result.dependencyDifferences).toEqual([])
  })

  it('requires review when install hooks or native binary files change', () => {
    const current = directory()
    const target = directory()
    for (const root of [current, target]) {
      write(root, 'requirements.txt', 'onnxruntime-gpu==1.22.0\n')
    }
    write(current, 'install.py', 'print("old")\n')
    write(target, 'install.py', 'print("new")\n')
    write(target, 'native/extension.pyd', 'fixture-native-binary')

    const result = plan(current, target)

    expect(result.verdict).toBe('review-required')
    expect(result.installHookDifferences).toContainEqual({ path: 'install.py', kind: 'changed' })
    expect(result.nativeBinaryChanges).toEqual(['native/extension.pyd'])
  })

  it('changes the plan digest when the exact target revision changes', () => {
    const current = directory()
    const target = directory()
    for (const root of [current, target]) {
      write(root, 'requirements.txt', 'onnxruntime-gpu==1.22.0\n')
    }

    const first = plan(current, target)
    const second = plan(current, target, { item: item({ latestVersion: '1.2.0' }) })

    expect(second.environmentFingerprint).not.toBe(first.environmentFingerprint)
    expect(second.planDigest).not.toBe(first.planDigest)
  })

  it('retains freeze references separately from dependency metadata versions', () => {
    const current = directory()
    const target = directory()
    const versions = {
      torch: '2.8.0+cu128',
      numpy: '2.2.6',
      'llama-cpp-python': '0.3.47',
      sageattention: '2.2.0+cu130torch2.10.0andhigher.post6'
    }
    const installedPackages = {
      torch: versions.torch,
      numpy: versions.numpy,
      llama_cpp_python: 'file:///C:/cache/llama_cpp_python.whl#sha256=' + 'a'.repeat(64),
      SageAttention: 'file:///D:/cache/sageattention.whl#sha256=' + 'b'.repeat(64)
    }
    const dependencyAnalysis = {
      current: [],
      target: [],
      issues: [],
      currentIssues: [],
      installedPackages: versions,
      installedRequirements: {},
      markerEnvironment: {}
    }

    const first = plan(current, target, { installedPackages, dependencyAnalysis })
    const second = plan(current, target, {
      installedPackages: {
        ...installedPackages,
        llama_cpp_python: 'file:///C:/cache/llama_cpp_python.whl#sha256=' + 'c'.repeat(64)
      },
      dependencyAnalysis
    })

    expect(first.verdict).toBe('ready')
    expect(first.installedPackages).toEqual({
      torch: versions.torch,
      numpy: versions.numpy,
      'llama-cpp-python': installedPackages.llama_cpp_python,
      sageattention: installedPackages.SageAttention
    })
    expect(second.environmentFingerprint).not.toBe(first.environmentFingerprint)
    expect(second.planDigest).not.toBe(first.planDigest)
  })
})

describe('declaration aggregation and markers', () => {
  it('accepts only an unexpired matching cached approval', () => {
    const current = directory()
    const target = directory()
    const result = plan(current, target)
    __testing.planCache.set('inst-1:compiled-node', {
      plan: result,
      expiresAt: Date.now() + 60_000
    })
    expect(getApprovedPluginPlan('inst-1', 'compiled-node', result.planDigest)).toBe(result)
    expect(getApprovedPluginPlan('inst-1', 'compiled-node', 'f'.repeat(64))).toBe(null)
    __testing.planCache.set('inst-1:compiled-node', { plan: result, expiresAt: Date.now() - 1 })
    expect(getApprovedPluginPlan('inst-1', 'compiled-node', result.planDigest)).toBe(null)
  })
  it('does not report repeated declarations in multiple files as new packages', () => {
    const current = directory()
    const target = directory()
    write(current, 'requirements.txt', 'numpy>=2')
    write(target, 'requirements.txt', 'numpy>=2')
    write(
      target,
      'pyproject.toml',
      '[project]\nname="node"\nversion="1"\ndependencies=["numpy>=2"]'
    )
    expect(plan(current, target).dependencyDifferences).toEqual([])
  })
  it('ignores dependencies whose platform marker excludes this environment', () => {
    const current = directory()
    const target = directory()
    write(target, 'requirements.txt', 'missing; sys_platform == "linux"')
    expect(plan(current, target).verdict).toBe('ready')
  })
  it('does not approve ordinary missing dependencies without a wheel plan', () => {
    const current = directory()
    const target = directory()
    write(target, 'requirements.txt', 'new-package>=1')
    expect(plan(current, target).executionMode).toBe('wheel-update')
  })
})
