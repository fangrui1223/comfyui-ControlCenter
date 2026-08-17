export const REQUIRED_PACKAGED_RUNTIME_ENTRIES: readonly string[]
export const PACKAGED_RUNTIME_ROOTS: readonly string[]
export function findMissingPackagedRuntimeEntries(
  entries: string[],
  requiredEntries?: readonly string[],
): string[]
export function findMissingPackagedDependencyClosure(options: {
  entries: string[]
  readPackageJson: (entry: string) => {
    name?: string
    dependencies?: Record<string, string>
  }
  rootPackages?: readonly string[]
}): string[]
export function verifyPackagedRuntime(asarPath: string): void
