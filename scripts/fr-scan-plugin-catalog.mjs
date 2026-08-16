import fs from 'node:fs'
import path from 'node:path'

const [sourceInstall, targetInstall, outputFile] = process.argv.slice(2)
if (!sourceInstall || !targetInstall || !outputFile) {
  throw new Error('Usage: node fr-scan-plugin-catalog.mjs <source> <target> <output>')
}

const customNodes = path.join(sourceInstall, 'custom_nodes')
const ignored = new Set(['__pycache__', '.disabled', 'websocket_image_save.py', 'example_node.py.example'])
const compiled = /tensorrt|onnxruntime|flash[-_]?attn|sageattention|xformers|triton|bitsandbytes|llama[-_]?cpp/i
const redundant = /^(comfyui[_-]memory[_-]cleanup|intelligentvramnode|comfyui[_-]reservedvram)$/i
const entries = fs.existsSync(customNodes)
  ? fs.readdirSync(customNodes, { withFileTypes: true })
      .filter((entry) => !ignored.has(entry.name) && !entry.name.startsWith('.'))
      .filter((entry) => entry.isDirectory() || entry.name.endsWith('.py'))
      .map((entry) => {
        const pluginPath = path.join(customNodes, entry.name)
        const requirementNames = ['requirements.txt', 'pyproject.toml', 'install.py', 'setup.py'].filter(
          (name) => entry.isDirectory() && fs.existsSync(path.join(pluginPath, name))
        )
        const corpus = requirementNames
          .map((name) => fs.readFileSync(path.join(pluginPath, name), 'utf8'))
          .join('\n')
        const isCompiled = compiled.test(`${entry.name}\n${corpus}`)
        const isRedundant = redundant.test(entry.name)
        return {
          directoryName: entry.name,
          sourcePath: pluginPath,
          lifecycle: isRedundant ? 'retired' : 'held-back',
          migrationDisposition: isRedundant
            ? 'retire-candidate'
            : isCompiled
              ? 'clean-install-required'
              : 'review-required',
          requirementFiles: requirementNames,
          hasCompiledDependencies: isCompiled,
          targetPath: path.join(targetInstall, 'ComfyUI', 'custom_nodes', entry.name),
          targetExists: fs.existsSync(path.join(targetInstall, 'ComfyUI', 'custom_nodes', entry.name))
        }
      })
      .sort((left, right) => left.directoryName.localeCompare(right.directoryName))
  : []

const report = {
  version: 1,
  generatedAt: new Date().toISOString(),
  strategy: 'clean-room-selective-reinstall',
  sourceInstall,
  targetInstall,
  sourceCustomNodes: customNodes,
  sourceReadOnly: true,
  entries,
  summary: {
    total: entries.length,
    heldBack: entries.filter((entry) => entry.lifecycle === 'held-back').length,
    retireCandidates: entries.filter((entry) => entry.lifecycle === 'retired').length,
    compiledDependencyCandidates: entries.filter((entry) => entry.hasCompiledDependencies).length,
    alreadyPresentInTarget: entries.filter((entry) => entry.targetExists).length
  }
}

fs.mkdirSync(path.dirname(outputFile), { recursive: true })
fs.writeFileSync(outputFile, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx' })
process.stdout.write(`${JSON.stringify(report.summary)}\n`)

