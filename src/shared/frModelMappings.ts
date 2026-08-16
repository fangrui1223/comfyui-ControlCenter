export type FrModelMappingDisposition =
  | 'core-extra-path'
  | 'plugin-verification-required'
  | 'blocked'

export interface FrModelDirectoryRecord {
  name: string
  physicalPath: string
  bytes: number
  files: number
  directories: number
  reparsePoint: boolean
  disposition: FrModelMappingDisposition
  logicalCategory: string | null
  referencedBy: Array<'stable' | 'next' | 'lab'>
  warning?: string
}

export interface FrModelLibraryInventory {
  schemaVersion: 1
  scannedAt: string
  sharedRoot: string
  coreSourceCommit: string
  totalBytes: number
  totalFiles: number
  records: FrModelDirectoryRecord[]
  errors: Array<{ path: string; message: string }>
}

export interface FrCoreModelMappingPlan {
  schemaVersion: 1
  transactionId: string
  createdAt: string
  sharedRoot: string
  environmentRoot: string
  configPath: string
  manifestPath: string
  undoManifestPath: string
  coreSourceCommit: string
  categoryPaths: Record<string, string[]>
  excluded: Array<{ name: string; reason: string }>
  collisions: Array<{ path: string; reason: string }>
  blocked: boolean
  digest: string
}

export interface FrPluginModelLinkDeclaration {
  pluginId: string
  sharedFolder: string
  targetRelativePath: string
  provenance: {
    repository: string
    commit: string
    evidenceFile: string
    evidenceLine: number
  }
}

export interface FrPluginModelLinkPlan extends FrPluginModelLinkDeclaration {
  source: string
  target: string
  status: 'ready' | 'already-mapped' | 'blocked'
  reason?: string
}
