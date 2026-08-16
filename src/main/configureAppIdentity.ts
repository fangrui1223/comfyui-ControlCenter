import { app } from 'electron'
import path from 'node:path'
import {
  FR_APP_DATA_DIRECTORY,
  FR_PACKAGE_NAME,
  FR_PRODUCT_NAME,
  FR_TELEMETRY_CHANNEL_CONFIGURED
} from '../shared/frProduct'

app.setName(FR_PRODUCT_NAME)

const e2eUserData =
  process.env['E2E'] === '1' ? process.env['FR_CONTROL_CENTER_E2E_USER_DATA'] : undefined
const userDataPath = e2eUserData
  ? path.resolve(e2eUserData)
  : path.join(
      app.getPath('appData'),
      process.platform === 'linux' ? FR_PACKAGE_NAME : FR_APP_DATA_DIRECTORY
    )

app.setPath('userData', userDataPath)
if (!FR_TELEMETRY_CHANNEL_CONFIGURED) {
  process.env['POSTHOG_ENABLED'] = '0'
}
try {
  app.setAppLogsPath(path.join(userDataPath, 'logs'))
} catch {
  // Logging-path setup must never prevent the control center from starting.
}
