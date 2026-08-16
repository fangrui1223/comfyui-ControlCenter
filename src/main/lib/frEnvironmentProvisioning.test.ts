import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mockState = vi.hoisted(() => ({ configDir: '' }))

vi.mock('./paths', () => ({ configDir: () => mockState.configDir }))

import {
  __testing,
  buildFrLayoutPlan,
  executeFrLayoutPlan,
  type FrLayoutRoots
} from './frEnvironmentProvisioning'

describe('FR environment layout transaction', () => {
  let root = ''
  let roots: FrLayoutRoots

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'fr-layout-'))
    mockState.configDir = path.join(root, 'config')
    fs.mkdirSync(mockState.configDir)
    roots = {
      stableRoot: path.join(root, 'stable'),
      sharedModelsRoot: path.join(root, 'stable', 'models'),
      nextRoot: path.join(root, 'next'),
      labRoot: path.join(root, 'lab'),
      cacheRoot: path.join(root, 'cache')
    }
  })

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true })
    vi.restoreAllMocks()
  })

  it('builds a read-only dry-run without creating any target', () => {
    const plan = buildFrLayoutPlan(roots, new Date('2026-08-16T00:00:00.000Z'))

    expect(plan.blocked).toBe(false)
    expect(plan.planDigest).toMatch(/^[a-f0-9]{64}$/)
    expect(plan.targets.map((target) => target.snapshot.state)).toEqual([
      'missing',
      'missing',
      'missing'
    ])
    expect(fs.existsSync(roots.nextRoot)).toBe(false)
    expect(fs.existsSync(roots.labRoot)).toBe(false)
    expect(fs.existsSync(roots.cacheRoot)).toBe(false)
  })

  it('blocks protected-path overlap and unowned content', () => {
    fs.mkdirSync(roots.labRoot)
    fs.writeFileSync(path.join(roots.labRoot, 'user.txt'), 'keep')
    roots.nextRoot = path.join(roots.stableRoot, 'next')

    const plan = buildFrLayoutPlan(roots)

    expect(plan.blocked).toBe(true)
    expect(plan.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'protected-next', status: 'blocked' }),
        expect.objectContaining({ id: 'occupied-lab', status: 'blocked' })
      ])
    )
    expect(fs.readFileSync(path.join(roots.labRoot, 'user.txt'), 'utf8')).toBe('keep')
  })

  it('atomically prepares isolated next, lab and cache layouts', () => {
    const plan = buildFrLayoutPlan(roots, new Date())
    const result = executeFrLayoutPlan(plan)

    expect(result.status).toBe('committed')
    expect(result.createdRoots).toEqual([roots.nextRoot, roots.labRoot, roots.cacheRoot])
    for (const target of plan.targets) {
      const marker = JSON.parse(
        fs.readFileSync(path.join(target.root, __testing.OWNER_DIR, __testing.OWNER_FILE), 'utf8')
      ) as { kind: string; state: string }
      expect(marker).toMatchObject({ kind: target.kind, state: 'prepared' })
      expect(target.stagingRoot && fs.existsSync(target.stagingRoot)).toBe(false)
    }
    expect(fs.existsSync(path.join(roots.nextRoot, __testing.OWNER_DIR, 'compiled-cache'))).toBe(
      true
    )
    expect(fs.existsSync(path.join(roots.cacheRoot, 'downloads'))).toBe(true)
  })

  it('refuses execution when a target changes after dry-run', () => {
    const plan = buildFrLayoutPlan(roots)
    fs.mkdirSync(roots.nextRoot)
    fs.writeFileSync(path.join(roots.nextRoot, 'appeared.txt'), 'keep')

    expect(() => executeFrLayoutPlan(plan)).toThrow('changed after dry-run')
    expect(fs.readFileSync(path.join(roots.nextRoot, 'appeared.txt'), 'utf8')).toBe('keep')
    expect(fs.existsSync(roots.labRoot)).toBe(false)
  })

  it('rejects a tampered plan before writing a journal', () => {
    const plan = buildFrLayoutPlan(roots)
    plan.targets[0]!.root = path.join(root, 'elsewhere')

    expect(() => executeFrLayoutPlan(plan)).toThrow('digest does not match')
    expect(fs.readdirSync(mockState.configDir)).toEqual([])
  })

  it('is idempotent for correctly owned prepared layouts', () => {
    const first = executeFrLayoutPlan(buildFrLayoutPlan(roots))
    expect(first.status).toBe('committed')

    const secondPlan = buildFrLayoutPlan(roots)
    expect(secondPlan.targets.every((target) => target.actions.length === 0)).toBe(true)
    const second = executeFrLayoutPlan(secondPlan)
    expect(second.status).toBe('committed')
    expect(second.createdRoots).toEqual([])
  })
})
