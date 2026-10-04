import { IN_PLACE_RELAUNCH } from '../../types/ipc'

/** Completion step for picker background actions; only explicit policy entries resume a session. */
export async function relaunchAfterAction(
  actionId: string,
  wasRunning: boolean,
  result: { ok: boolean },
  relaunch: () => Promise<unknown>
): Promise<void> {
  if (result.ok && wasRunning && IN_PLACE_RELAUNCH.has(actionId)) await relaunch()
}
