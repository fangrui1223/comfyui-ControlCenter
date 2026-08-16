export const FR_ENVIRONMENT_ROLES = ['stable', 'next', 'lab'] as const
export type FrEnvironmentRole = (typeof FR_ENVIRONMENT_ROLES)[number]

export type FrEnvironmentManagementMode = 'unregistered' | 'read-only' | 'managed'
export type FrEnvironmentFolderState =
  | 'not-checked'
  | 'directory'
  | 'missing'
  | 'not-directory'
  | 'inaccessible'

export interface FrEnvironmentProfile {
  role: FrEnvironmentRole
  mode: FrEnvironmentManagementMode
  /** Null until the user explicitly chooses a folder. */
  path: string | null
  /** ISO timestamp for the most recent explicit registration/mode change. */
  updatedAt: string | null
  /** Present only after explicit managed-mode authorization. */
  managedAuthorizedAt: string | null
}

export interface FrEnvironmentProfileView extends FrEnvironmentProfile {
  /** Display-only suggestion. It is never scanned or adopted automatically. */
  suggestedPath: string
  /** Unregistered suggestions are deliberately reported as not-checked. */
  folderState: FrEnvironmentFolderState
}

export interface SaveFrEnvironmentProfileInput {
  role: FrEnvironmentRole
  mode: FrEnvironmentManagementMode
  path?: string | null
}
