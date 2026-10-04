import { SEED_ROWS } from './seed'
import {
  migrateToCurrent,
  normalizeModules,
  normalizeRows,
  STORAGE_KEY,
  STORAGE_VERSION,
  StorageStructureError,
} from './schema'
import type { EntryRow } from './types'

// 本地持久化：数据放在 localStorage 里，刷新、关掉再打开都还在。
// 结构版本、字段次序与迁移路径的定义集中在 ./schema，这里只负责读写与缓存。

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function hasLocalStorage(): boolean {
  return typeof window !== 'undefined' && Boolean(window.localStorage)
}

function seedModules(): Record<string, EntryRow[]> {
  // 种子数据也过一遍同一份结构定义，保证落库结构与读出来的结构一致
  return normalizeModules(clone(SEED_ROWS), {})
}

function persist(modules: Record<string, EntryRow[]>): void {
  if (!hasLocalStorage()) {
    return
  }
  const envelope = { version: STORAGE_VERSION, modules }
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(envelope))
}

function readStorage(): Record<string, EntryRow[]> {
  const fallback = seedModules()
  if (!hasLocalStorage()) {
    return fallback
  }
  const raw = window.localStorage.getItem(STORAGE_KEY)
  if (!raw) {
    persist(fallback)
    return fallback
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    // 内容损坏：报清楚问题，存量数据原样保留，不整块扔掉
    throw new StorageStructureError('内容不是有效的 JSON')
  }
  // 按版本把存量数据搬过来；认不出的版本会抛出带版本号的错误，存量不动
  const envelope = migrateToCurrent(parsed)
  const stored = (envelope.modules ?? {}) as Record<string, unknown>
  const normalized = { ...fallback, ...normalizeModules(stored, fallback) }
  // 搬完立刻按当前版本落库，刷新后读到的字段与落库那份一致
  persist(normalized)
  return normalized
}

let cache: Record<string, EntryRow[]> | null = null

export function allRows(): Record<string, EntryRow[]> {
  if (cache === null) {
    cache = readStorage()
  }
  return cache
}

export function listRows(key: string): EntryRow[] {
  return allRows()[key] ?? []
}

export function saveRows(key: string, rows: EntryRow[]): void {
  // 写回也过同一份结构定义：落库的结构和读出来的结构出自同一处
  const next = { ...allRows(), [key]: normalizeRows(key, rows).rows }
  cache = next
  persist(next)
}

export function resetRows(key: string): EntryRow[] {
  // 回收只动当前模块：其它模块已录好的行原样保留
  saveRows(key, clone(SEED_ROWS[key] ?? []))
  return listRows(key)
}

/** 清掉内存缓存，下次读取重新走 localStorage（模拟刷新、测试都用它）。 */
export function invalidateCache(): void {
  cache = null
}

export function storageKey(): string {
  return STORAGE_KEY
}

export function storageVersion(): number {
  return STORAGE_VERSION
}
