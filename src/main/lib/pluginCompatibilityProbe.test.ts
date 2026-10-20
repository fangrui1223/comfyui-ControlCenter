import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { afterEach, describe, expect, it } from 'vitest'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

function fixture(pluginSource: string) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fr-plugin-probe-'))
  roots.push(root)
  const plugin = path.join(root, 'custom_nodes', 'fixture-node')
  const write = (name: string, source: string) => {
    const target = path.join(root, name)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, source)
  }
  write('folder_paths.py', '')
  write('app/__init__.py', '')
  write('app/assets/__init__.py', '')
  write('app/assets/manager.py', 'def default_asset_manager(): return object()\n')
  write('comfy_extras/__init__.py', '')
  // Reproduce nodes_latent <-> nodes_post_processing in the reported core.
  write(
    'comfy_extras/nodes_latent.py',
    `import comfy_extras.nodes_post_processing
def reshape_latent_to(): pass
class LatentBatch: pass
NODE_CLASS_MAPPINGS = {'BuiltinLatent': LatentBatch}
`
  )
  write(
    'comfy_extras/nodes_post_processing.py',
    'from comfy_extras.nodes_latent import reshape_latent_to\n'
  )
  write(
    'server.py',
    `import pathlib, sys
class Session:
    closed = False
    async def close(self):
        self.closed = True
        pathlib.Path('session-closed').touch()
class PromptServer:
    instance = None
    def __init__(self, loop, asset_manager):
        assert '--disable-all-custom-nodes' in sys.argv
        PromptServer.instance = self
        self.client_session = Session()
`
  )
  write(
    'nodes.py',
    `import importlib.util, pathlib, sys, traceback
from server import PromptServer
NODE_CLASS_MAPPINGS = {'CoreNode': object()}
async def load_custom_node(module_path, ignore=set(), module_parent='custom_nodes'):
    try:
        source = pathlib.Path(module_path)
        if source.is_dir(): source = source / '__init__.py'
        # ComfyUI loads builtins under their absolute source path, allowing
        # their canonical imports to finish before external nodes are loaded.
        spec = importlib.util.spec_from_file_location(str(source), source)
        module = importlib.util.module_from_spec(spec)
        sys.modules[spec.name] = module
        spec.loader.exec_module(module)
        for name, value in module.NODE_CLASS_MAPPINGS.items():
            if name not in ignore: NODE_CLASS_MAPPINGS[name] = value
        return True
    except Exception:
        traceback.print_exc()
        return False
async def init_extra_nodes(init_custom_nodes=True, init_api_nodes=True):
    assert PromptServer.instance is not None
    assert init_custom_nodes is False
    assert init_api_nodes is False
    assert await load_custom_node(str(pathlib.Path(__file__).parent / 'comfy_extras/nodes_latent.py'), module_parent='comfy_extras')
`
  )
  write('custom_nodes/fixture-node/__init__.py', pluginSource)
  return { root, plugin }
}

function probe(root: string, plugin: string) {
  const python = process.env.FR_TEST_PYTHON ?? (process.platform === 'win32' ? 'python' : 'python3')
  return spawnSync(
    python,
    [
      '-I',
      '-B',
      '-X',
      'utf8',
      path.resolve('lib/plugin_compatibility_probe.py'),
      'import-smoke',
      '--comfyui-dir',
      root,
      '--plugin-dir',
      plugin
    ],
    { encoding: 'utf8', windowsHide: true, timeout: 10_000 }
  )
}

describe('plugin import validation startup', () => {
  it('loads core extras before the target and excludes builtin nodes from its node count', () => {
    const f = fixture(
      "from comfy_extras.nodes_latent import LatentBatch\nNODE_CLASS_MAPPINGS = {'PluginOnly': LatentBatch}\n"
    )
    const result = probe(f.root, f.plugin)
    expect(result.error).toBeUndefined()
    expect(result.stderr).toBe('')
    expect(result.status).toBe(0)
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: true,
      nodeClassCount: 1,
      hasNodeMappings: true
    })
    expect(fs.existsSync(path.join(f.root, 'session-closed'))).toBe(true)
  })

  it('still rejects a broken target and closes the validation session', () => {
    const f = fixture("raise RuntimeError('target plugin import failed')\n")
    const result = probe(f.root, f.plugin)
    expect(result.error).toBeUndefined()
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('target plugin import failed')
    expect(result.stderr).toContain('native custom-node loader rejected the plugin')
    expect(fs.existsSync(path.join(f.root, 'session-closed'))).toBe(true)
  })
})
