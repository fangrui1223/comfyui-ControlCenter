import { ipcMain } from 'electron'
import path from 'node:path'
import * as installations from '../../installations'
import { getPluginUpdateInventory } from '../pluginUpdates'
import { getPluginCompatibilityPlan } from '../pluginCompatibility'
import { recordIpcInvocation } from '../e2eOverrides'

export function registerPluginUpdateHandlers(): void {
  ipcMain.handle(
    'get-plugin-updates',
    async (_event, installationId: unknown, refresh: unknown = false) => {
      recordIpcInvocation('get-plugin-updates', { installationId, refresh })
      if (typeof installationId !== 'string' || !installationId) {
        throw new Error('A valid installation id is required.')
      }
      const installation = await installations.get(installationId)
      if (!installation) throw new Error('Installation not found.')
      return getPluginUpdateInventory(installation, refresh === true)
    }
  )
  ipcMain.handle(
    'get-plugin-compatibility-plan',
    async (_event, installationId: unknown, dirName: unknown, refresh: unknown = false) => {
      recordIpcInvocation('get-plugin-compatibility-plan', {
        installationId,
        dirName,
        refresh
      })
      if (typeof installationId !== 'string' || !installationId) {
        throw new Error('A valid installation id is required.')
      }
      if (
        typeof dirName !== 'string' ||
        !dirName ||
        dirName !== path.basename(dirName) ||
        /[\\/\0]/.test(dirName)
      ) {
        throw new Error('A valid plugin directory name is required.')
      }
      const installation = await installations.get(installationId)
      if (!installation) throw new Error('Installation not found.')
      return getPluginCompatibilityPlan(installation, dirName, refresh === true)
    }
  )
}
