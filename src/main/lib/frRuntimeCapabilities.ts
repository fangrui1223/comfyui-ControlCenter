import childProcess from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import type {
  FrGpuProbe,
  FrOptionalAcceleratorProfile,
  FrRuntimeEvaluation,
  FrRuntimeProbe,
  FrRuntimeProfile
} from '../../shared/frRuntimeCapabilities'

const CHECKED_AT = '2026-08-16'

const evidence = {
  comfyInstall: {
    title: 'ComfyUI official installation guidance',
    url: 'https://github.com/Comfy-Org/ComfyUI#installing',
    authority: 'official-project' as const,
    checkedAt: CHECKED_AT
  },
  comfyBundle: {
    title: 'ComfyUI official standalone environment catalog',
    url: 'https://desktop-assets.comfy.org/standalone-environments/latest.json',
    authority: 'official-project' as const,
    checkedAt: CHECKED_AT
  },
  pytorch212: {
    title: 'PyTorch 2.12 release',
    url: 'https://pytorch.org/blog/pytorch-2-12-release-blog/',
    authority: 'official-project' as const,
    checkedAt: CHECKED_AT
  },
  tritonWindows: {
    title: 'triton-windows 3.7 compatibility release',
    url: 'https://github.com/triton-lang/triton-windows/releases/tag/v3.7.1-windows.post27',
    authority: 'upstream-repository' as const,
    checkedAt: CHECKED_AT
  },
  sageAttention: {
    title: 'SageAttention official Blackwell implementation',
    url: 'https://github.com/thu-ml/SageAttention/tree/main/sageattention3_blackwell',
    authority: 'official-project' as const,
    checkedAt: CHECKED_AT
  },
  xformers: {
    title: 'xFormers v0.0.35 release',
    url: 'https://github.com/facebookresearch/xformers/releases/tag/v0.0.35',
    authority: 'official-project' as const,
    checkedAt: CHECKED_AT
  },
  tensorrt: {
    title: 'NVIDIA TensorRT support matrix',
    url: 'https://docs.nvidia.com/deeplearning/tensorrt/latest/getting-started/support-matrix.html',
    authority: 'official-vendor' as const,
    checkedAt: CHECKED_AT
  }
}

export const FR_RUNTIME_CATALOG_VERSION = 1

export const FR_RUNTIME_PROFILES: readonly FrRuntimeProfile[] = [
  {
    id: 'win-nvidia-py313-torch2121-cu130',
    catalogVersion: FR_RUNTIME_CATALOG_VERSION,
    channel: 'stable',
    label: 'Windows NVIDIA · Python 3.13 · PyTorch 2.12.1 / CUDA 13.0',
    confidence: 'verified-official',
    platform: 'win32',
    accelerator: 'nvidia',
    python: '3.13.12',
    packages: [
      {
        name: 'torch',
        version: '2.12.1+cu130',
        source: 'https://download.pytorch.org/whl/cu130'
      },
      {
        name: 'torchvision',
        version: '0.27.1+cu130',
        source: 'https://download.pytorch.org/whl/cu130'
      },
      {
        name: 'torchaudio',
        version: '2.11.0+cu130',
        source: 'https://download.pytorch.org/whl/cu130'
      }
    ],
    minComputeCapability: 12,
    minDriver: '580.88',
    compiledCachePolicy: 'per-environment',
    installSource: {
      kind: 'comfy-standalone',
      url: 'https://desktop-assets.comfy.org/standalone-environments/win-nvidia/v0.29.0-env1/comfyui-standalone-win-nvidia-v0.29.0-env1.7z',
      releaseTag: 'v0.29.0-env1',
      expectedBytes: 2307213244
    },
    evidence: [evidence.comfyBundle, evidence.comfyInstall, evidence.pytorch212],
    notes: [
      'Official ComfyUI Windows standalone tuple; prefer it over manually mixing wheel generations.',
      'Python patch upgrades are separate transactions even when the CPython 3.13 ABI is unchanged.',
      'CUDA 13.0 targets Blackwell; CUDA 12.8 is deprecated in the PyTorch 2.12 standard matrix.'
    ]
  },
  {
    id: 'win-nvidia-py313-torch-nightly-cu132',
    catalogVersion: FR_RUNTIME_CATALOG_VERSION,
    channel: 'preview',
    label: 'Windows NVIDIA · current PyTorch nightly / CUDA 13.2',
    confidence: 'upstream-declared',
    platform: 'win32',
    accelerator: 'nvidia',
    python: '3.13',
    packages: [
      {
        name: 'torch/vision/audio',
        version: 'resolve-at-transaction-time',
        source: 'https://download.pytorch.org/whl/nightly/cu132'
      }
    ],
    minComputeCapability: 12,
    minDriver: '580.88',
    compiledCachePolicy: 'per-environment',
    installSource: {
      kind: 'python-index',
      url: 'https://download.pytorch.org/whl/nightly/cu132'
    },
    evidence: [evidence.comfyInstall, evidence.pytorch212],
    notes: [
      'Lab only. Resolve and freeze the exact nightly date before download.',
      'Never share compiled extensions or caches with the stable channel.'
    ]
  }
]

export const FR_OPTIONAL_ACCELERATORS: readonly FrOptionalAcceleratorProfile[] = [
  {
    id: 'triton-windows-3.7',
    label: 'Triton for Windows 3.7',
    channel: 'stable',
    confidence: 'upstream-declared',
    package: {
      name: 'triton-windows',
      version: '>=3.7.1,<3.8',
      source: 'https://pypi.org/project/triton-windows/'
    },
    torchConstraint: 'PyTorch 2.12.x',
    pythonConstraint: '>=3.10,<=3.14',
    cudaConstraint: '>=12.8',
    computeCapabilities: 'sm120 supported',
    activation: 'automatic',
    compiledCachePolicy: 'per-environment',
    qualityGate: 'smoke',
    targetDisposition: 'recommended',
    evidence: [evidence.tritonWindows],
    notes: ['Pin below 3.8 because the 3.7 release line is coupled to PyTorch 2.12.']
  },
  {
    id: 'xformers-0.0.35-cu130',
    label: 'xFormers 0.0.35 / CUDA 13.0',
    channel: 'experimental',
    confidence: 'upstream-declared',
    package: {
      name: 'xformers',
      version: '0.0.35',
      source: 'https://download.pytorch.org/whl/cu130',
      optional: true
    },
    torchConstraint: '>=2.10 (stable PyTorch C++ API/ABI)',
    pythonConstraint: 'Python-independent wheel metadata; validate CPython import',
    cudaConstraint: 'cu130 wheel',
    computeCapabilities: 'Blackwell CUTLASS fMHA added in 0.0.33',
    activation: 'automatic',
    compiledCachePolicy: 'per-environment',
    qualityGate: 'numerical-comparison',
    targetDisposition: 'blocked-on-target',
    evidence: [evidence.xformers],
    notes: [
      'ComfyUI may select xFormers automatically when import and kernels are available.',
      'RTX 5090 probe on 2026-08-16: 0.0.35/cu130 imports, but every fMHA candidate rejects SM120; do not install in next.',
      'Reopen only when a later official wheel passes the numerical and dispatch probe.'
    ]
  },
  {
    id: 'sageattention3-blackwell',
    label: 'SageAttention 3 for Blackwell',
    channel: 'experimental',
    confidence: 'experimental',
    package: {
      name: 'sageattn3',
      version: 'source-commit-required',
      source: 'https://github.com/thu-ml/SageAttention/tree/main/sageattention3_blackwell',
      optional: true
    },
    torchConstraint: 'validate exact build tuple',
    pythonConstraint: '>=3.9',
    cudaConstraint: '>=12.8',
    computeCapabilities: 'Blackwell only',
    activation: 'per-workflow',
    compiledCachePolicy: 'per-environment',
    qualityGate: 'workflow-comparison',
    targetDisposition: 'lab-only',
    evidence: [evidence.sageAttention],
    notes: [
      'Performance-first candidate, but SageAttention upstream states SageAttention2 is more accurate.',
      'Do not globally replace attention for Wan/Qwen/Krea/FLUX until per-workflow output comparison passes.'
    ]
  },
  {
    id: 'tensorrt-current',
    label: 'TensorRT current supported release',
    channel: 'experimental',
    confidence: 'upstream-declared',
    package: {
      name: 'tensorrt',
      version: 'resolve-from-NVIDIA-matrix',
      source: 'https://pypi.nvidia.com',
      optional: true
    },
    torchConstraint: 'node-specific; not a ComfyUI core dependency',
    pythonConstraint: '3.10-3.14 wheel support',
    cudaConstraint: '12.x or 13.x per selected release',
    computeCapabilities: 'engine built and validated on target GPU',
    activation: 'per-workflow',
    compiledCachePolicy: 'per-environment',
    qualityGate: 'workflow-comparison',
    targetDisposition: 'lab-only',
    evidence: [evidence.tensorrt],
    notes: [
      'Serialized engines are not assumed portable across TensorRT versions or GPU architectures.',
      'Install only for a verified TensorRT custom node; never make it a base-environment requirement.'
    ]
  }
]

export const FR_PROBED_PACKAGES = [
  'torch',
  'torchvision',
  'torchaudio',
  'transformers',
  'diffusers',
  'accelerate',
  'triton',
  'triton_windows',
  'sageattention',
  'sageattn3',
  'xformers',
  'tensorrt'
] as const

export function parseNvidiaSmiCsv(output: string): FrGpuProbe | null {
  const first = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean)
  if (!first) return null
  const columns = first.split(',').map((column) => column.trim())
  if (columns.length < 4) return null
  const memory = Number.parseInt(columns[2]!, 10)
  const capability = Number.parseFloat(columns[3]!)
  if (!columns[0] || !columns[1] || !Number.isFinite(memory) || !Number.isFinite(capability)) {
    return null
  }
  return {
    name: columns[0],
    driverVersion: columns[1],
    memoryMiB: memory,
    computeCapability: capability
  }
}

function versionParts(value: string): number[] {
  return value.split(/[.+-]/).map((part) => Number.parseInt(part, 10) || 0)
}

export function compareVersions(left: string, right: string): number {
  const a = versionParts(left)
  const b = versionParts(right)
  for (let index = 0; index < Math.max(a.length, b.length); index++) {
    const delta = (a[index] ?? 0) - (b[index] ?? 0)
    if (delta !== 0) return delta
  }
  return 0
}

export function inspectDistInfoVersions(
  sitePackages: string,
  packageNames: readonly string[] = FR_PROBED_PACKAGES
): Record<string, string | null> {
  const result = Object.fromEntries(packageNames.map((name) => [name, null])) as Record<
    string,
    string | null
  >
  let entries: string[]
  try {
    entries = fs.readdirSync(sitePackages)
  } catch {
    return result
  }
  for (const name of packageNames) {
    const normalized = name.replace(/[-_.]+/g, '[-_.]+')
    const pattern = new RegExp(`^${normalized}-(.+)\\.dist-info$`, 'i')
    const entry = entries.find((candidate) => pattern.test(candidate))
    const match = entry?.match(pattern)
    if (match?.[1]) result[name] = match[1]
  }
  return result
}

function probeLongPaths(): boolean | null {
  if (process.platform !== 'win32') return null
  try {
    const output = childProcess.execFileSync(
      'reg.exe',
      ['query', 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\FileSystem', '/v', 'LongPathsEnabled'],
      { encoding: 'utf8', windowsHide: true }
    )
    return /LongPathsEnabled\s+REG_DWORD\s+0x1/i.test(output)
  } catch {
    return null
  }
}

export function collectFrRuntimeProbe(sitePackages?: string): FrRuntimeProbe {
  let gpu: FrGpuProbe | null
  try {
    gpu = parseNvidiaSmiCsv(
      childProcess.execFileSync(
        'nvidia-smi.exe',
        [
          '--query-gpu=name,driver_version,memory.total,compute_cap',
          '--format=csv,noheader,nounits'
        ],
        { encoding: 'utf8', windowsHide: true }
      )
    )
  } catch {
    gpu = null
  }
  return {
    capturedAt: new Date().toISOString(),
    platform: process.platform,
    arch: process.arch,
    longPathsEnabled: probeLongPaths(),
    gpu,
    packageVersions: sitePackages
      ? inspectDistInfoVersions(path.resolve(sitePackages))
      : inspectDistInfoVersions('')
  }
}

export function evaluateRuntimeProfile(
  profile: FrRuntimeProfile,
  probe: FrRuntimeProbe
): FrRuntimeEvaluation {
  const checks: FrRuntimeEvaluation['checks'] = []
  checks.push({
    id: 'platform',
    status: probe.platform === profile.platform && probe.arch === 'x64' ? 'pass' : 'blocked',
    summary: `${probe.platform}/${probe.arch}; profile requires ${profile.platform}/x64`
  })
  if (!probe.gpu) {
    checks.push({ id: 'gpu', status: 'blocked', summary: 'NVIDIA GPU probe unavailable' })
  } else {
    checks.push({
      id: 'compute-capability',
      status: probe.gpu.computeCapability >= profile.minComputeCapability ? 'pass' : 'blocked',
      summary: `${probe.gpu.name} reports sm${String(probe.gpu.computeCapability).replace('.', '')}`
    })
    checks.push({
      id: 'driver',
      status: compareVersions(probe.gpu.driverVersion, profile.minDriver) >= 0 ? 'pass' : 'blocked',
      summary: `Driver ${probe.gpu.driverVersion}; minimum ${profile.minDriver}`
    })
    checks.push({
      id: 'vram',
      status: probe.gpu.memoryMiB >= 24 * 1024 ? 'pass' : 'warning',
      summary: `${probe.gpu.memoryMiB} MiB VRAM detected`
    })
  }
  checks.push({
    id: 'long-paths',
    status: probe.longPathsEnabled === true ? 'pass' : 'warning',
    summary:
      probe.longPathsEnabled === true
        ? 'Windows long paths are enabled'
        : 'Windows long-path state could not be confirmed'
  })
  return {
    profileId: profile.id,
    eligibility: checks.some((check) => check.status === 'blocked')
      ? 'blocked'
      : checks.some((check) => check.status === 'warning')
        ? 'needs-validation'
        : 'eligible',
    checks
  }
}
