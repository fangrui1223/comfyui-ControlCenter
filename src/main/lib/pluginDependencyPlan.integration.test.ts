import { execFileSync } from 'node:child_process'
import { expect, it } from 'vitest'

it('analyzes markers and resolves exact wheel plans offline with real uv', () => {
  const python = process.env.FR_TEST_PYTHON ?? (process.platform === 'win32' ? 'python' : 'python3')
  const output = execFileSync(
    python,
    [
      '-I',
      '-B',
      '-m',
      'unittest',
      'discover',
      '-s',
      'src/main/lib/__fixtures__',
      '-p',
      'test_plugin_dependency_plan.py',
      '-v'
    ],
    {
      windowsHide: true,
      encoding: 'utf-8',
      timeout: 60_000,
      env: { ...process.env, FR_TEST_UV: process.env.FR_TEST_UV ?? 'uv' }
    }
  )
  expect(output).toBe('')
}, 60_000)
