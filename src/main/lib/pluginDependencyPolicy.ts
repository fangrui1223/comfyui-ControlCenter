const COMPILED_DEPENDENCY_PATTERNS = [
  /^onnxruntime(?:-gpu|-directml|-openvino)?$/,
  /^opencv-python(?:-headless)?$/,
  /^insightface$/,
  /^flash-attn$/,
  /^sageattention$/,
  /^xformers$/,
  /^triton(?:-windows)?$/,
  /^tensorrt(?:-.+)?$/,
  /^torch-tensorrt$/,
  /^bitsandbytes$/,
  /^llama-cpp-python$/
]

const PROTECTED_DEPENDENCY_PATTERNS = [
  /^python$/,
  /^torch$/,
  /^torchvision$/,
  /^torchaudio$/,
  /^torchsde$/,
  /^numpy$/,
  /^triton(?:-windows)?$/,
  /^xformers$/,
  /^flash-attn$/,
  /^sageattention$/,
  /^tensorrt(?:-.+)?$/,
  /^torch-tensorrt$/,
  /^nvidia-.+$/,
  /^cuda(?:-.+)?$/
]

export function normalizePythonPackageName(value: string): string {
  return value
    .trim()
    .toLocaleLowerCase('en-US')
    .replace(/[-_.]+/g, '-')
}

export function isCompiledDependency(value: string): boolean {
  const normalized = normalizePythonPackageName(value)
  return COMPILED_DEPENDENCY_PATTERNS.some((pattern) => pattern.test(normalized))
}

export function isProtectedDependency(value: string): boolean {
  const normalized = normalizePythonPackageName(value)
  return PROTECTED_DEPENDENCY_PATTERNS.some((pattern) => pattern.test(normalized))
}

export function containsCompiledDependencyDeclaration(value: string): boolean {
  return value.split(/\r?\n/).some((line) => {
    const match = /^\s*([A-Za-z0-9_.-]+)/.exec(line)
    return match ? isCompiledDependency(match[1]!) : false
  })
}
