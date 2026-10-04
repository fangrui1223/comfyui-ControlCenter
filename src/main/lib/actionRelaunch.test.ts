import { describe, expect, it, vi } from 'vitest'
import { relaunchAfterAction } from './actionRelaunch'

describe('picker background action completion', () => {
  it.each(['update-plugins', 'update-plugin-compatible'])(
    '%s never launches after success, failure or retry, regardless of prior running state',
    async (actionId) => {
      const launch = vi.fn(async () => ({ ok: true }))
      for (const wasRunning of [true, false]) {
        for (const ok of [true, false]) {
          await relaunchAfterAction(actionId, wasRunning, { ok }, launch)
          await relaunchAfterAction(actionId, wasRunning, { ok }, launch)
        }
      }
      expect(launch).not.toHaveBeenCalled()
    }
  )

  it.each(['update-comfyui', 'snapshot-restore', 'change-pytorch'])(
    '%s still resumes a previously running instance only after success',
    async (actionId) => {
      const launch = vi.fn(async () => ({ ok: true }))
      await relaunchAfterAction(actionId, false, { ok: true }, launch)
      await relaunchAfterAction(actionId, true, { ok: false }, launch)
      expect(launch).not.toHaveBeenCalled()
      await relaunchAfterAction(actionId, true, { ok: true }, launch)
      expect(launch).toHaveBeenCalledOnce()
    }
  )
})
