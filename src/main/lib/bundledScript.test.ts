import { describe, it, expect, vi } from 'vitest'
import fs from 'fs'
import path from 'path'

// At runtime __dirname is <projectRoot>/out/main, so the dev-mode formula must
// resolve from there to <projectRoot>/lib/<script>.
const PROJECT_ROOT = path.resolve(__dirname, '..', '..', '..')

/** Simulate the dev-mode path resolution as it runs inside the bundle. */
function devScriptPath(scriptName: string): string {
  const bundledDir = path.join(PROJECT_ROOT, 'out', 'main')
  return path.join(bundledDir, '..', '..', 'lib', scriptName)
}

describe('bundled script paths', () => {
  it('dev-mode path resolves to lib/update_comfyui.py which exists', () => {
    const resolved = path.resolve(devScriptPath('update_comfyui.py'))
    expect(resolved).toBe(path.join(PROJECT_ROOT, 'lib', 'update_comfyui.py'))
    expect(fs.existsSync(resolved)).toBe(true)
  })

  it('dev-mode path resolves to lib/git_operations.py which exists', () => {
    const resolved = path.resolve(devScriptPath('git_operations.py'))
    expect(resolved).toBe(path.join(PROJECT_ROOT, 'lib', 'git_operations.py'))
    expect(fs.existsSync(resolved)).toBe(true)
  })

  it('dev-mode path resolves to lib/manager_operations.py which exists', () => {
    const resolved = path.resolve(devScriptPath('manager_operations.py'))
    expect(resolved).toBe(path.join(PROJECT_ROOT, 'lib', 'manager_operations.py'))
    expect(fs.existsSync(resolved)).toBe(true)
    expect(fs.readFileSync(resolved, 'utf-8')).toContain('instant_execution=True')
  })

  it('dev-mode path resolves to the restricted plugin compatibility probe', () => {
    const resolved = path.resolve(devScriptPath('plugin_compatibility_probe.py'))
    expect(resolved).toBe(path.join(PROJECT_ROOT, 'lib', 'plugin_compatibility_probe.py'))
    expect(fs.existsSync(resolved)).toBe(true)
    const source = fs.readFileSync(resolved, 'utf-8')
    expect(source).toContain('import-smoke')
    expect(source).toContain('PromptServer(loop, default_asset_manager())')
    expect(source).toContain('nodes.load_custom_node(')
    expect(source).not.toContain('spec.loader.exec_module')
  })

  it('getBundledScriptPath uses the same formula in dev mode', async () => {
    vi.mock('electron', () => ({ app: { isPackaged: false } }))
    const { getBundledScriptPath } = await import('./bundledScript')
    const result = getBundledScriptPath('update_comfyui.py')
    expect(result).toContain('update_comfyui.py')
    expect(result.endsWith(path.join('lib', 'update_comfyui.py'))).toBe(true)
  })
})
