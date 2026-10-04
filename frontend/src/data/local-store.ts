import { SEED_ROWS } from './seed'
import {
  LEGACY_VERSION,
  QUARANTINE_KEY_PREFIX,
  STORAGE_KEY,
  STORAGE_VERSION,
  isKnownModule,
  knownModules,
  normalizeBucket,
  type MigrationIssue,
  type MigrationReport,
  type StoredEnvelope,
} from './schema'
import type { EntryRow } from './types'

// 本地持久化：数据放在带结构版本的 localStorage 信封里。
// 读取时按版本把存量数据逐模块、逐行搬过来；认不出的结构登记清楚是哪一版对不上，
// 原始内容隔离留底而不是整块覆盖。

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function seedEnvelope(): StoredEnvelope {
  return { version: STORAGE_VERSION, modules: clone(SEED_ROWS) }
}

function hasStorage(): boolean {
  return typeof window !== 'undefined' && !!window.localStorage
}

function writeEnvelope(envelope: StoredEnvelope): void {
  if (hasStorage()) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(envelope))
  }
}

function quarantine(raw: string): string {
  const key = `${QUARANTINE_KEY_PREFIX}${Date.now()}`
  if (hasStorage()) {
    try {
      window.localStorage.setItem(key, raw)
    } catch {
      // localStorage 写满或被禁用：留底失败也不能挡住主流程
    }
  }
  return key
}

function issue(
  issues: MigrationIssue[],
  kind: MigrationIssue['kind'],
  detail: string,
  fromVersion: number | null = null,
  module: string | null = null,
  fields: string[] = [],
): void {
  issues.push({ kind, fromVersion, module, detail, fields })
}

/**
 * 把任意形状的解析结果搬成当前信封。
 * - v1（无版本的纯 map）逐模块搬迁；
 * - 高于当前版本（老浏览器打开新数据）不丢弃：能搬的模块照搬，登记版本对不上；
 * - 形状整个认不出来时用种子兜底，并把原始数据隔离留底。
 */
function migrateParsed(
  parsed: unknown,
  reportedVersion: number | null,
  issues: MigrationIssue[],
): {
  envelope: StoredEnvelope
  repairedRows: Record<string, number>
  migrated: boolean
  /** 整桶形状认不出来、需要把原文隔离留底 */
  salvageWhole: boolean
} {
  let modulesMap: Record<string, unknown> | undefined
  if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
    const record = parsed as Record<string, unknown>
    const modules = record.modules
    if (modules && typeof modules === 'object' && !Array.isArray(modules)) {
      modulesMap = modules as Record<string, unknown>
    } else if (reportedVersion === LEGACY_VERSION) {
      modulesMap = record
    }
  }

  if (!modulesMap || typeof modulesMap !== 'object') {
    issue(
      issues,
      'shape-mismatch',
      reportedVersion === null
        ? '存量数据既没有版本号也不是「模块 -> 数据行」的结构，已整桶隔离留底并用示例数据补位'
        : `结构版本 v${reportedVersion} 的信封里找不到 modules 分块，无法按业务模块搬迁，原文已隔离留底`,
      reportedVersion,
    )
    return { envelope: seedEnvelope(), repairedRows: {}, migrated: true, salvageWhole: true }
  }

  if (reportedVersion !== null && reportedVersion > STORAGE_VERSION) {
    issue(
      issues,
      'version-mismatch',
      `存量数据是 v${reportedVersion} 结构，当前程序只认到 v${STORAGE_VERSION}；已按 v${STORAGE_VERSION} 尽量搬迁，认不出的字段原样保留，请在支持新版本的环境里复核`,
      reportedVersion,
    )
  }

  const repairedRows: Record<string, number> = {}
  const nextModules: Record<string, EntryRow[]> = {}

  for (const meta of knownModules()) {
    if (!Object.prototype.hasOwnProperty.call(modulesMap, meta.key)) {
      // 老数据里还没有这一整块业务：用示例种子补齐这一块，其他模块不受影响
      nextModules[meta.key] = clone(SEED_ROWS[meta.key] ?? [])
      continue
    }
    const rawBucket = modulesMap[meta.key]
    if (!Array.isArray(rawBucket)) {
      issue(
        issues,
        'bucket-replaced',
        `模块「${meta.name}」(v${reportedVersion ?? '?'}) 的数据不是数组，该块已退回示例数据`,
        reportedVersion,
        meta.key,
      )
      nextModules[meta.key] = clone(SEED_ROWS[meta.key] ?? [])
      continue
    }

    const result = normalizeBucket(rawBucket, meta)
    if (result.dropped > 0) {
      issue(
        issues,
        'row-dropped',
        `模块「${meta.name}」有 ${result.dropped} 行不是对象记录，搬迁时只丢弃这几行`,
        reportedVersion,
        meta.key,
      )
    }
    for (const item of result.refilled) {
      issue(
        issues,
        'field-refilled',
        `模块「${meta.name}」编号 ${item.row.id} 的字段 ${item.fields.join('、')} 缺失或为非法值，已按定义次序补填并退回待办`,
        reportedVersion,
        meta.key,
        item.fields,
      )
    }
    if (result.refilled.length > 0) {
      repairedRows[meta.key] = result.refilled.length
    }
    nextModules[meta.key] = result.rows
  }

  // 认不出是谁家的模块桶：不删，原样带在信封里，等新版本认领
  for (const key of Object.keys(modulesMap)) {
    if (!isKnownModule(key) && !(key in nextModules)) {
      const value = modulesMap[key]
      // 未经识别的分块不做任何清洗，原样保留（类型上按未知数据寄存）
      nextModules[key] = (Array.isArray(value) ? value : [value]) as EntryRow[]
      issue(
        issues,
        'version-mismatch',
        `存在当前版本不认识的业务分块「${key}」，已原样保留，未做任何清理`,
        reportedVersion,
        key,
      )
    }
  }

  return {
    envelope: { version: STORAGE_VERSION, modules: nextModules },
    repairedRows,
    migrated: reportedVersion !== STORAGE_VERSION || issues.length > 0,
    salvageWhole: false,
  }
}

let cache: StoredEnvelope | null = null
let lastReport: MigrationReport | null = null

function readStorage(): StoredEnvelope {
  const fallback = seedEnvelope()
  if (!hasStorage()) {
    lastReport = {
      fromVersion: null,
      toVersion: STORAGE_VERSION,
      migrated: false,
      repairedRows: {},
      issues: [],
      quarantineKey: null,
    }
    return fallback
  }

  const raw = window.localStorage.getItem(STORAGE_KEY)
  if (!raw) {
    writeEnvelope(fallback)
    lastReport = {
      fromVersion: null,
      toVersion: STORAGE_VERSION,
      migrated: false,
      repairedRows: {},
      issues: [],
      quarantineKey: null,
    }
    return fallback
  }

  const issues: MigrationIssue[] = []
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    const quarantineKey = quarantine(raw)
    issue(
      issues,
      'unparseable',
      '存量数据无法解析为 JSON，已把原文隔离留底并用示例数据补位；其他业务未受影响',
    )
    const envelope = seedEnvelope()
    writeEnvelope(envelope)
    publishReport({ fromVersion: null, envelope, repairedRows: {}, issues, quarantineKey, migrated: true })
    return envelope
  }

  const reportedVersion = readVersion(parsed)
  const { envelope, repairedRows, migrated, salvageWhole } = migrateParsed(
    parsed,
    reportedVersion,
    issues,
  )
  const quarantineKey = salvageWhole ? quarantine(raw) : null

  // 搬迁后立即落库：刷新再读到的就是同一份结构，避免每次都重新搬
  if (migrated || issues.length > 0 || reportedVersion !== STORAGE_VERSION) {
    writeEnvelope(envelope)
  }

  publishReport({
    fromVersion: reportedVersion,
    envelope,
    repairedRows,
    issues,
    quarantineKey,
    migrated,
  })
  return envelope
}

function readVersion(parsed: unknown): number | null {
  if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
    const version = (parsed as Record<string, unknown>).version
    if (typeof version === 'number' && Number.isFinite(version)) {
      return version
    }
  }
  // 没有版本号的最早一版存量：纯 map，整桶直接就是模块数据
  if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
    return LEGACY_VERSION
  }
  return null
}

function publishReport(input: {
  fromVersion: number | null
  envelope: StoredEnvelope
  repairedRows: Record<string, number>
  issues: MigrationIssue[]
  quarantineKey: string | null
  migrated: boolean
}): void {
  lastReport = {
    fromVersion: input.fromVersion,
    toVersion: STORAGE_VERSION,
    migrated: input.migrated,
    repairedRows: input.repairedRows,
    issues: input.issues,
    quarantineKey: input.quarantineKey,
  }
  if (input.issues.length > 0 && typeof console !== 'undefined') {
    console.warn(
      `[local-store] 本地存储由 v${input.fromVersion ?? '未知'} 搬迁到 v${STORAGE_VERSION}，登记 ${input.issues.length} 条问题`,
      input.issues,
    )
  }
}

function envelope(): StoredEnvelope {
  if (cache === null) {
    cache = readStorage()
  }
  return cache
}

/** 仅供测试：清掉模块内缓存，下一次读取重新走搬迁。 */
export function __reloadForTest(): void {
  cache = null
  lastReport = null
}

export function allRows(): Record<string, EntryRow[]> {
  return envelope().modules
}

export function listRows(key: string): EntryRow[] {
  return allRows()[key] ?? []
}

export function saveRows(key: string, rows: EntryRow[]): void {
  const current = envelope()
  const next: StoredEnvelope = {
    version: STORAGE_VERSION,
    modules: { ...current.modules, [key]: rows },
  }
  cache = next
  // 这一块已被重新写入（编辑或回收），迁移时挂在该模块上的补填待办随之核销
  if (lastReport && key in lastReport.repairedRows) {
    delete lastReport.repairedRows[key]
  }
  writeEnvelope(next)
}

/**
 * 回收（重置）只动当前这一块业务：只替换该 key 的分块，
 * 其他模块录好的数据原样保留，绝不再整桶覆盖。
 */
export function resetRows(key: string): EntryRow[] {
  const rows = clone(SEED_ROWS[key] ?? [])
  saveRows(key, rows)
  return rows
}

export function storageKey(): string {
  return STORAGE_KEY
}

export function storageVersion(): number {
  return STORAGE_VERSION
}

/** 最近一次读取时的搬迁报告：版本对不上、补填了哪些行都在这里查。 */
export function migrationReport(): MigrationReport | null {
  if (cache === null) {
    envelope()
  }
  return lastReport
}
