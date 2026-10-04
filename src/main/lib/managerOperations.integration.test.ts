import { execFileSync } from 'node:child_process'
import { expect, it } from 'vitest'

it('runs the Python Manager v4 adapter regression suite offline', () => {
  const python = process.env.FR_TEST_PYTHON ?? (process.platform === 'win32' ? 'python' : 'python3')
  expect(() =>
    execFileSync(
      python,
      [
        '-B',
        '-s',
        '-m',
        'unittest',
        'discover',
        '-s',
        'src/main/lib/__fixtures__',
        '-p',
        'test_manager_operations.py',
        '-v'
      ],
      { cwd: process.cwd(), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }
    )
  ).not.toThrow()
})
