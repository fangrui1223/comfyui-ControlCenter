import { listLocalCommits, lsRemoteLatestTag, lsRemoteRef, lsRemoteStableTags } from './git'
import { getComfyUIRemoteUrl } from './github-mirror'
import { fetchJSON } from './fetch'
import * as settings from '../settings'

const REPO = 'Comfy-Org/ComfyUI'
const STABLE_TAG_RE = /^v\d+\.\d+\.\d+$/

export interface ComfyUIReleaseInfo {
  tag: string
  name: string
  notes: string
  url: string
  publishedAt?: string
}

export interface ComfyUIDevelopmentRevision {
  sha: string
  shortSha: string
  title: string
  url: string
  committedAt?: string
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

/**
 * Best-effort release metadata enrichment. Git tags remain authoritative for
 * update availability, so GitHub API failures never block an update check.
 */
async function fetchStableReleaseMetadata(
  tag: string,
  opts?: { refresh?: boolean }
): Promise<Record<string, unknown> | null> {
  try {
    return asRecord(
      await fetchJSON(
        `https://api.github.com/repos/${REPO}/releases/tags/${encodeURIComponent(tag)}`,
        { refresh: opts?.refresh }
      )
    )
  } catch {
    return null
  }
}

/** Resolve one strict stable tag and enrich it with GitHub release metadata.
 * The synthetic fallback keeps historical version switching usable offline. */
export async function fetchStableRelease(
  tag: string,
  opts?: { refresh?: boolean }
): Promise<Record<string, unknown> | null> {
  if (!STABLE_TAG_RE.test(tag)) return null
  const metadata = await fetchStableReleaseMetadata(tag, opts)
  return {
    ...(metadata ?? {}),
    tag_name: tag,
    name: typeof metadata?.name === 'string' && metadata.name.trim() ? metadata.name : tag,
    body: typeof metadata?.body === 'string' ? metadata.body : '',
    html_url:
      typeof metadata?.html_url === 'string' && /^https?:\/\//i.test(metadata.html_url)
        ? metadata.html_url
        : `https://github.com/${REPO}/releases/tag/${tag}`,
    baseTag: tag,
    commitsAhead: 0
  }
}

/** Renderer-safe release information for the historical-version picker. */
export async function getStableReleaseInfo(tag: string): Promise<ComfyUIReleaseInfo | null> {
  const release = await fetchStableRelease(tag)
  if (!release) return null
  const publishedAt =
    typeof release.published_at === 'string' && release.published_at
      ? release.published_at
      : undefined
  return {
    tag,
    name: typeof release.name === 'string' && release.name.trim() ? release.name : tag,
    notes: truncateNotes(typeof release.body === 'string' ? release.body : '', 4000),
    url:
      typeof release.html_url === 'string' && /^https?:\/\//i.test(release.html_url)
        ? release.html_url
        : `https://github.com/${REPO}/releases/tag/${tag}`,
    ...(publishedAt ? { publishedAt } : {})
  }
}

/** Recent commits on ComfyUI master, newest first. These are the only commit
 * targets exposed by the ordinary development picker; manual SHAs belong in
 * the advanced flow. Falls back to the remote head when commit metadata is
 * unavailable (offline/rate-limited). */
export async function getDevelopmentRevisions(opts?: {
  refresh?: boolean
  limit?: number
  repoPath?: string
  headSha?: string
}): Promise<ComfyUIDevelopmentRevision[]> {
  const limit = Math.min(20, Math.max(1, Math.trunc(opts?.limit ?? 20)))
  const remoteUrl = _getRemoteUrl()
  const suppliedHead =
    typeof opts?.headSha === 'string' && /^[0-9a-f]{40}$/i.test(opts.headSha)
      ? opts.headSha
      : undefined
  const headSha =
    suppliedHead ??
    (await lsRemoteRef(remoteUrl, 'refs/heads/master').catch(() => null)) ??
    undefined

  // Prefer the already-present local object graph for the exact remote head.
  // This is read-only and survives GitHub REST rate limits (the common reason
  // the old implementation collapsed to one synthetic HEAD entry).
  let localRevisions: ComfyUIDevelopmentRevision[] = []
  if (opts?.repoPath && headSha) {
    localRevisions = (await listLocalCommits(opts.repoPath, headSha, limit)).map((commit) => ({
      sha: commit.sha,
      shortSha: commit.sha.slice(0, 7),
      title: commit.title,
      url: `https://github.com/${REPO}/commit/${commit.sha}`,
      ...(commit.committedAt ? { committedAt: commit.committedAt } : {})
    }))
    if (localRevisions.length >= Math.min(2, limit)) return localRevisions
  }

  try {
    const apiRef = headSha ?? 'master'
    const raw = await fetchJSON(
      `https://api.github.com/repos/${REPO}/commits?sha=${encodeURIComponent(apiRef)}&per_page=${limit}`,
      { refresh: opts?.refresh }
    )
    if (Array.isArray(raw)) {
      const revisions = raw.flatMap((value): ComfyUIDevelopmentRevision[] => {
        const item = asRecord(value)
        const sha = typeof item?.sha === 'string' ? item.sha : ''
        if (!/^[0-9a-f]{40}$/i.test(sha)) return []
        const commit = asRecord(item?.commit)
        const committer = asRecord(commit?.committer)
        const message = typeof commit?.message === 'string' ? commit.message.trim() : ''
        const title = message.split(/\r?\n/, 1)[0] || `master ${sha.slice(0, 7)}`
        const rawUrl = typeof item?.html_url === 'string' ? item.html_url : ''
        const committedAt =
          typeof committer?.date === 'string' && committer.date ? committer.date : undefined
        return [
          {
            sha,
            shortSha: sha.slice(0, 7),
            title,
            url: /^https?:\/\//i.test(rawUrl) ? rawUrl : `https://github.com/${REPO}/commit/${sha}`,
            ...(committedAt ? { committedAt } : {})
          }
        ]
      })
      if (revisions.length > 0) return revisions.slice(0, limit)
    }
  } catch {
    // fall through to local/head-only fallbacks
  }

  if (localRevisions.length > 0) return localRevisions
  if (!headSha || !/^[0-9a-f]{40}$/i.test(headSha)) return []
  return [
    {
      sha: headSha,
      shortSha: headSha.slice(0, 7),
      title: `master ${headSha.slice(0, 7)}`,
      url: `https://github.com/${REPO}/commit/${headSha}`
    }
  ]
}

/** Short-lived cache for the latest stable tag, keyed by remote URL, to avoid
 *  repeated `git ls-remote` calls in close succession. */
const SUCCESS_TTL_MS = 10 * 60 * 1000
const FAILURE_TTL_MS = 30_000
interface CacheEntry {
  tag: string | null
  expiresAt: number
}
const _latestTagCache = new Map<string, CacheEntry>()
let _inflight: Map<string, Promise<string | null>> = new Map()

interface StableTagsCacheEntry {
  tags: string[]
  expiresAt: number
}
const _stableTagsCache = new Map<string, StableTagsCacheEntry>()
let _stableTagsInflight: Map<string, Promise<string[]>> = new Map()

function _getRemoteUrl(): string {
  return getComfyUIRemoteUrl(settings.get('useChineseMirrors') === true)
}

/**
 * Resolve the latest stable ComfyUI tag via `git ls-remote --tags` (no REST
 * API; works against github.com and gitcode.com). Concurrent callers share one
 * in-flight request per remote. Returns `null` (never throws) on failure.
 * `refresh: true` bypasses the cache.
 */
export async function getLatestStableTag(opts?: { refresh?: boolean }): Promise<string | null> {
  const url = _getRemoteUrl()
  const now = Date.now()
  if (!opts?.refresh) {
    const hit = _latestTagCache.get(url)
    if (hit && now < hit.expiresAt) return hit.tag
  }
  const existing = _inflight.get(url)
  if (existing) return existing
  const promise = (async () => {
    try {
      const tag = (await lsRemoteLatestTag(url)) ?? null
      // A `null` tag means no git backend was configured; cache it as a failure
      // (short TTL) rather than poisoning SUCCESS_TTL_MS, which would strand new
      // standalone installs on the bundled version.
      const ttl = tag === null ? FAILURE_TTL_MS : SUCCESS_TTL_MS
      _latestTagCache.set(url, { tag, expiresAt: Date.now() + ttl })
      return tag
    } catch {
      _latestTagCache.set(url, { tag: null, expiresAt: Date.now() + FAILURE_TTL_MS })
      return null
    } finally {
      _inflight.delete(url)
    }
  })()
  _inflight.set(url, promise)
  return promise
}

/** Test-only: clear the in-memory cache. */
export function _clearLatestStableTagCache(): void {
  _latestTagCache.clear()
  _inflight = new Map()
  _stableTagsCache.clear()
  _stableTagsInflight = new Map()
}

/**
 * Resolve every stable ComfyUI tag via `git ls-remote --tags`. "Stable" means
 * strict `vMAJOR.MINOR.PATCH` (no prerelease / suffix). Tags are returned
 * newest-first. Cached per remote URL with the same TTLs as
 * {@link getLatestStableTag}; concurrent callers share one in-flight request.
 * Returns an empty array (never throws) on failure. `refresh: true` bypasses
 * the cache.
 */
export async function getStableTags(opts?: { refresh?: boolean }): Promise<string[]> {
  const url = _getRemoteUrl()
  const now = Date.now()
  if (!opts?.refresh) {
    const hit = _stableTagsCache.get(url)
    if (hit && now < hit.expiresAt) return hit.tags
  }
  const existing = _stableTagsInflight.get(url)
  if (existing) return existing
  const promise = (async () => {
    try {
      const tags = await lsRemoteStableTags(url)
      const ttl = tags.length === 0 ? FAILURE_TTL_MS : SUCCESS_TTL_MS
      _stableTagsCache.set(url, { tags, expiresAt: Date.now() + ttl })
      return tags
    } catch {
      _stableTagsCache.set(url, { tags: [], expiresAt: Date.now() + FAILURE_TTL_MS })
      return []
    } finally {
      _stableTagsInflight.delete(url)
    }
  })()
  _stableTagsInflight.set(url, promise)
  return promise
}

export async function fetchLatestRelease(
  channel: string,
  opts?: { refresh?: boolean }
): Promise<Record<string, unknown> | null> {
  const mirrorEnabled = settings.get('useChineseMirrors') === true
  const remoteUrl = getComfyUIRemoteUrl(mirrorEnabled)

  if (channel === 'latest') {
    const [headSha, latestTag] = await Promise.all([
      lsRemoteRef(remoteUrl, 'refs/heads/master'),
      getLatestStableTag(opts)
    ])
    if (!headSha) return null
    return {
      tag_name: headSha.slice(0, 7),
      commitSha: headSha,
      baseTag: latestTag || undefined,
      // commitsAhead is resolved locally after git fetch
      body: '',
      html_url: `https://github.com/${REPO}/commit/${headSha}`,
      _commit: true
    }
  }

  // Stable channel: the git tag remains authoritative, then enrich it with
  // the GitHub Release title/body/date when available. Falling back to the
  // synthetic record preserves update checks on offline/rate-limited systems.
  const latestTag = await getLatestStableTag(opts)
  if (!latestTag) return null
  return fetchStableRelease(latestTag, opts)
}

export function truncateNotes(text: string, maxLen: number): string {
  if (!text) return ''
  if (text.length <= maxLen) return text
  return text.slice(0, maxLen) + '\n\n… (truncated)'
}
