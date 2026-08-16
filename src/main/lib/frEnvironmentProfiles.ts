import fs from 'node:fs'
import path from 'node:path'
import {
  FR_ENVIRONMENT_ROLES,
  type FrEnvironmentFolderState,
  type FrEnvironmentManagementMode,
  type FrEnvironmentProfile,
  type FrEnvironmentProfileView,
  type FrEnvironmentRole,
  type SaveFrEnvironmentProfileInput
} from '../../shared/frEnvironmentProfiles'
import { configDir } from './paths'
import { readFileSafe, writeFileSafe } from './safe-file'

const REGISTRY_VERSION = 1
const REGISTRY_FILENAME = 'fr-environments.json'

interface RegistryDocument {
  version: typeof REGISTRY_VERSION
  profiles: FrEnvironmentProfile[]
}

function registryPath(): string {
  return path.join(configDir(), REGISTRY_FILENAME)
}

function suggestedPaths(): Record<FrEnvironmentRole, string> {
  if (process.platform === 'win32') {
    return {
      stable: 'C:\\FR_comfyui',
      next: 'C:\\FR_comfyui_next',
      lab: 'C:\\FR_comfyui_lab'
    }
  }
  return {
    stable: path.join(process.env['HOME'] || '/', 'FR_comfyui'),
    next: path.join(process.env['HOME'] || '/', 'FR_comfyui_next'),
    lab: path.join(process.env['HOME'] || '/', 'FR_comfyui_lab')
  }
}

function emptyProfile(role: FrEnvironmentRole): FrEnvironmentProfile {
  return {
    role,
    mode: 'unregistered',
    path: null,
    updatedAt: null,
    managedAuthorizedAt: null
  }
}

function isRole(value: unknown): value is FrEnvironmentRole {
  return typeof value === 'string' && FR_ENVIRONMENT_ROLES.includes(value as FrEnvironmentRole)
}

function isMode(value: unknown): value is FrEnvironmentManagementMode {
  return value === 'unregistered' || value === 'read-only' || value === 'managed'
}

function parseProfile(value: unknown): FrEnvironmentProfile | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const row = value as Record<string, unknown>
  if (!isRole(row.role) || !isMode(row.mode)) return null
  const profilePath = typeof row.path === 'string' && row.path.trim() ? row.path.trim() : null
  if (row.mode !== 'unregistered' && !profilePath) return null
  return {
    role: row.role,
    mode: row.mode,
    path: row.mode === 'unregistered' ? null : profilePath,
    updatedAt: typeof row.updatedAt === 'string' ? row.updatedAt : null,
    managedAuthorizedAt:
      row.mode === 'managed' && typeof row.managedAuthorizedAt === 'string'
        ? row.managedAuthorizedAt
        : null
  }
}

function loadRegistry(): { document: RegistryDocument; writable: boolean } {
  const result = readFileSafe(registryPath())
  if (result.kind === 'absent') {
    return {
      document: { version: REGISTRY_VERSION, profiles: [] },
      writable: true
    }
  }
  if (result.kind === 'unreadable') {
    throw new Error('FR environment registry is temporarily unreadable')
  }
  try {
    const raw = JSON.parse(result.data) as { version?: unknown; profiles?: unknown }
    if (raw.version !== REGISTRY_VERSION || !Array.isArray(raw.profiles)) {
      throw new Error('unsupported registry format')
    }
    const profiles = raw.profiles.map(parseProfile)
    if (profiles.some((profile) => profile === null)) {
      throw new Error('invalid profile entry')
    }
    return {
      document: { version: REGISTRY_VERSION, profiles: profiles as FrEnvironmentProfile[] },
      // A backup may be used for display while antivirus locks the primary, but
      // it must never be written back over a potentially newer primary file.
      writable: result.primaryUnreadable !== true
    }
  } catch (error) {
    throw new Error(
      `FR environment registry is invalid: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error }
    )
  }
}

function normalizeForCollision(folderPath: string): string {
  const resolved = path.resolve(folderPath)
  return process.platform === 'win32' ? resolved.toLocaleLowerCase('en-US') : resolved
}

function folderState(profile: FrEnvironmentProfile): FrEnvironmentFolderState {
  // This is the central M1 safety boundary: suggested defaults are never
  // probed until the user explicitly registers a profile.
  if (profile.mode === 'unregistered' || !profile.path) return 'not-checked'
  try {
    const stat = fs.statSync(profile.path)
    return stat.isDirectory() ? 'directory' : 'not-directory'
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'inaccessible'
  }
}

export function listFrEnvironmentProfiles(): FrEnvironmentProfileView[] {
  const { document } = loadRegistry()
  const suggestions = suggestedPaths()
  return FR_ENVIRONMENT_ROLES.map((role) => {
    const profile =
      document.profiles.find((candidate) => candidate.role === role) ?? emptyProfile(role)
    return {
      ...profile,
      suggestedPath: suggestions[role],
      folderState: folderState(profile)
    }
  })
}

/**
 * Persist profile metadata only. This function never creates, modifies, scans,
 * launches or repairs the selected ComfyUI directory.
 */
export function saveFrEnvironmentProfile(
  input: SaveFrEnvironmentProfileInput
): FrEnvironmentProfileView[] {
  if (!isRole(input.role)) throw new Error('Unknown FR environment role')
  if (!isMode(input.mode)) throw new Error('Unknown FR environment management mode')

  const loaded = loadRegistry()
  if (!loaded.writable) {
    throw new Error('FR environment registry is locked; no changes were written')
  }

  const selectedPath = typeof input.path === 'string' ? input.path.trim() : ''
  if (input.mode !== 'unregistered') {
    if (!selectedPath) throw new Error('A folder must be selected before registration')
    if (!path.isAbsolute(selectedPath)) throw new Error('FR environment path must be absolute')
  }

  if (input.mode !== 'unregistered') {
    const collision = loaded.document.profiles.find(
      (profile) =>
        profile.role !== input.role &&
        profile.mode !== 'unregistered' &&
        profile.path &&
        normalizeForCollision(profile.path) === normalizeForCollision(selectedPath)
    )
    if (collision) {
      throw new Error(`This folder is already registered as the ${collision.role} environment`)
    }
  }

  const previous = loaded.document.profiles.find((profile) => profile.role === input.role)
  const now = new Date().toISOString()
  const next: FrEnvironmentProfile =
    input.mode === 'unregistered'
      ? emptyProfile(input.role)
      : {
          role: input.role,
          mode: input.mode,
          path: path.normalize(selectedPath),
          updatedAt: now,
          managedAuthorizedAt:
            input.mode === 'managed'
              ? previous?.mode === 'managed'
                ? (previous.managedAuthorizedAt ?? now)
                : now
              : null
        }

  const profiles = loaded.document.profiles.filter((profile) => profile.role !== input.role)
  if (next.mode !== 'unregistered') profiles.push(next)
  writeFileSafe(
    registryPath(),
    JSON.stringify({ version: REGISTRY_VERSION, profiles }, null, 2) + '\n',
    { backup: true }
  )
  return listFrEnvironmentProfiles()
}

export const __testing = { registryPath, suggestedPaths }
