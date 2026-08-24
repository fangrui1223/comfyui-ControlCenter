export const COMFY_WORKSPACE_BROWSER = 'browser'
export const COMFY_WORKSPACE_EMBEDDED = 'embedded'

export type ComfyWorkspaceMode = typeof COMFY_WORKSPACE_BROWSER | typeof COMFY_WORKSPACE_EMBEDDED

/** Browser is the FR default because large ComfyUI graphs render more smoothly
 * in the user's full browser than in Electron's embedded WebContentsView. */
export function resolveComfyWorkspaceMode(value: unknown): ComfyWorkspaceMode {
  return value === COMFY_WORKSPACE_EMBEDDED ? COMFY_WORKSPACE_EMBEDDED : COMFY_WORKSPACE_BROWSER
}

/** Console/external launch modes already own their presentation and must not be
 * redirected by the global Comfy workspace preference. */
export function shouldOpenComfyWorkspaceInBrowser(value: unknown, launchMode: string): boolean {
  return (
    launchMode !== 'console' &&
    launchMode !== 'external' &&
    resolveComfyWorkspaceMode(value) === COMFY_WORKSPACE_BROWSER
  )
}

export function resolveComfyWorkspaceUrl(port: number, url?: string): string {
  return url || `http://127.0.0.1:${port}`
}
