import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { InstallationRecord } from '../installations'
import type { PluginCompatibilityPlan } from '../../types/ipc'
const mocks = vi.hoisted(() => ({ download: vi.fn(), runLoggedProcess: vi.fn() }))
vi.mock('./download', () => ({ download: mocks.download }))
vi.mock('./logged-process', () => ({ runLoggedProcess: mocks.runLoggedProcess }))
vi.mock('./pythonEnv', () => ({ getActivePythonPath: () => 'python', getActiveUvPath: () => 'uv' }))
import { prepareApprovedWheels, installApprovedWheels } from './pluginWheelInstall'

const roots: string[] = []
afterEach(() => {
  vi.resetAllMocks()
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fr-wheel-install-'))
  roots.push(root)
  const installation = { id: 'test', installPath: root } as InstallationRecord
  const content = 'approved wheel bytes'
  const sha256 = crypto.createHash('sha256').update(content).digest('hex')
  const plan = {
    executionMode: 'wheel-update',
    planDigest: 'b'.repeat(64),
    packageChanges: [
      {
        name: 'sample',
        from: null,
        to: '1',
        kind: 'added',
        reason: 'direct',
        compiled: false,
        protected: false,
        wheel: {
          filename: 'sample-1-py3-none-any.whl',
          url: 'https://files.pythonhosted.org/sample.whl',
          sha256,
          size: content.length,
          tags: ['py3-none-any']
        }
      }
    ]
  } as PluginCompatibilityPlan
  mocks.download.mockImplementation(async (_url, destination) => {
    fs.writeFileSync(destination, content)
  })
  return { installation, plan, content }
}
describe('approved wheel installation', () => {
  it('reuses a verified wheel cache and writes local hashed requirements', async () => {
    const f = fixture()
    const requirements = await prepareApprovedWheels(f.installation, f.plan)
    const contents = fs.readFileSync(requirements, 'utf-8')
    expect(contents).toContain('sample @ file:///')
    expect(contents).toContain('--hash=sha256:' + f.plan.packageChanges![0]!.wheel.sha256)
    await prepareApprovedWheels(f.installation, f.plan)
    expect(mocks.download).toHaveBeenCalledOnce()
  })
  it('rejects incorrect wheel bytes before creating the install requirements', async () => {
    const f = fixture()
    mocks.download.mockImplementation(async (_url, destination) => {
      fs.writeFileSync(destination, 'incorrect')
    })
    await expect(prepareApprovedWheels(f.installation, f.plan)).rejects.toThrow(
      'hash verification failed'
    )
    expect(
      fs.existsSync(
        path.join(
          f.installation.installPath,
          '.launcher',
          'plugin-wheel-cache',
          f.plan.planDigest + '.txt'
        )
      )
    ).toBe(false)
  })
  it.each(['torch', 'numpy', 'xformers'])(
    'rejects protected package %s before download',
    async (name) => {
      const f = fixture()
      f.plan.packageChanges![0]!.name = name
      await expect(prepareApprovedWheels(f.installation, f.plan)).rejects.toThrow('separate review')
      expect(mocks.download).not.toHaveBeenCalled()
    }
  )
  it('disallows untrusted package origins', async () => {
    const f = fixture()
    f.plan.packageChanges![0]!.wheel.url = 'https://example.org/sample.whl'
    await expect(prepareApprovedWheels(f.installation, f.plan)).rejects.toThrow('separate review')
    expect(mocks.download).not.toHaveBeenCalled()
  })
  it('executes uv with offline, no-deps, no-build and hash verification', async () => {
    const f = fixture()
    mocks.runLoggedProcess.mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' })
    await installApprovedWheels(f.installation, 'approved.txt', () => {})
    expect(mocks.runLoggedProcess).toHaveBeenCalledWith(
      'uv',
      expect.arrayContaining([
        '--offline',
        '--no-index',
        '--no-deps',
        '--no-build',
        '--require-hashes',
        '--link-mode',
        'copy'
      ]),
      expect.any(Object)
    )
  })
})
