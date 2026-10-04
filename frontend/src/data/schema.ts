import { MODULE_BY_KEY } from './modules'
import type { EntryRow } from './types'

// 本地存储结构的唯一出处：存储键、结构版本、字段次序、迁移路径都定义在这里。
// 读（local-store 读存量）、写（saveRows 落库）、种子（seed）都引用这一份，不各自抄一遍，
// 保证存进去的结构和读出来的结构出自同一定义。
export const STORAGE_KEY = 'substation-protection:entries'

// 当前存储结构版本。历史版本：1 = 未带版本号的 { 模块键: 行数组 } 平铺结构。
export const STORAGE_VERSION = 2

// 读写都认得的版本范围，版本对不上时用它给出明确提示。
export const SUPPORTED_VERSIONS: readonly number[] = [1, 2]

// 每条数据行的固定前缀字段，业务字段按模块定义里的次序跟在后面。
export const BASE_FIELDS = ['id', 'status', 'pending', 'abnormal'] as const

export type StorageEnvelope = {
  version: number
  modules: Record<string, EntryRow[]>
}

/** 存量数据连结构都认不出来（不是条目对象、内容损坏）时抛出，存量保持原样。 */
export class StorageStructureError extends Error {
  constructor(detail: string) {
    super(
      `本地存储里的数据无法识别（${detail}），存量数据保持原样未做清除，` +
        `请备份后清理浏览器里的「${STORAGE_KEY}」再重试`,
    )
    this.name = 'StorageStructureError'
  }
}

/** 存量数据带了版本号，但和当前应用支持的版本对不上时抛出，存量保持原样。 */
export class StorageVersionError extends Error {
  readonly foundVersion: number
  readonly supportedVersions: readonly number[]

  constructor(foundVersion: number) {
    super(
      `本地存储结构版本 ${foundVersion} 与当前应用支持的版本 ${SUPPORTED_VERSIONS.join('、')} 对不上，` +
        `存量数据保持原样未做清除，请升级应用或联系运维处理`,
    )
    this.name = 'StorageVersionError'
    this.foundVersion = foundVersion
    this.supportedVersions = SUPPORTED_VERSIONS
  }
}

/** 模块在定义里的字段次序：固定前缀 + 模块业务字段，读写都按这个次序排。 */
export function canonicalFields(key: string): string[] {
  const meta = MODULE_BY_KEY.get(key)
  return [...BASE_FIELDS, ...(meta?.fields ?? [])]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isFieldValue(value: unknown): value is string | number | boolean {
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
}

export type NormalizeResult = {
  rows: EntryRow[]
  /** 被退回补填的行数：缺字段或写了非法值的行会标成待办。 */
  repaired: number
}

/**
 * 把某个模块的存量行逐条搬到当前结构：
 * - 缺的字段按定义里的次序补齐（业务字段补成空串，等待补填）；
 * - 写成非法值的字段退回成空串，整行标成待办，落到待办清单里等人补填；
 * - 定义里没有的字段不带走，行内字段严格按定义次序排列。
 */
export function normalizeRows(key: string, rawRows: unknown): NormalizeResult {
  const meta = MODULE_BY_KEY.get(key)
  // 没登记的模块没有结构定义，原样带回，不擅自改写
  if (!meta) {
    return { rows: Array.isArray(rawRows) ? (rawRows as EntryRow[]) : [], repaired: 0 }
  }
  const lastStatus = meta.statuses[meta.statuses.length - 1]
  const list = Array.isArray(rawRows) ? rawRows : []
  const rows: EntryRow[] = []
  let repaired = 0
  let maxId = 0
  for (const item of list) {
    const source = isRecord(item) ? item : {}
    let rowRepaired = !isRecord(item)

    // id：必须是有限数字，认不出来的顺次补一个空号
    const rawId = source.id
    let id: number
    if (typeof rawId === 'number' && Number.isFinite(rawId)) {
      id = rawId
    } else if (typeof rawId === 'string' && rawId.trim() !== '' && Number.isFinite(Number(rawId))) {
      id = Number(rawId)
    } else {
      id = maxId + 1
      rowRepaired = true
    }
    maxId = Math.max(maxId, id)

    // status：非法就退回模块的第一个状态
    const rawStatus = source.status
    let status: string
    if (typeof rawStatus === 'string' && rawStatus.trim() !== '') {
      status = rawStatus
    } else {
      status = meta.statuses[0] ?? ''
      rowRepaired = true
    }

    // pending / abnormal：老数据缺了按状态推导、补 false，这是补齐不算返修
    const pending = typeof source.pending === 'boolean' ? source.pending : status !== lastStatus
    const abnormal = typeof source.abnormal === 'boolean' ? source.abnormal : false

    const row: EntryRow = { id, status, pending, abnormal }
    // 业务字段按定义次序补齐；写成非法值（对象、数组、null）的退回空串等待补填
    for (const field of meta.fields) {
      const value = source[field]
      if (isFieldValue(value)) {
        row[field] = value
      } else {
        row[field] = ''
        rowRepaired = true
      }
    }
    // 被修过的行退回待办清单，提醒值班员补填
    if (rowRepaired) {
      row.pending = true
      repaired += 1
    }
    rows.push(row)
  }
  return { rows, repaired }
}

/**
 * 把整份模块数据搬到当前结构：登记的模块逐行规整，没登记的模块键原样保留，
 * 模块值不是数组（已损坏）时退回该模块的种子数据。
 */
export function normalizeModules(
  modules: Record<string, unknown>,
  fallback: Record<string, EntryRow[]>,
): Record<string, EntryRow[]> {
  const normalized: Record<string, EntryRow[]> = {}
  for (const [key, value] of Object.entries(modules)) {
    if (!MODULE_BY_KEY.has(key)) {
      normalized[key] = value as EntryRow[]
      continue
    }
    normalized[key] = Array.isArray(value)
      ? normalizeRows(key, value).rows
      : JSON.parse(JSON.stringify(fallback[key] ?? [])) as EntryRow[]
  }
  return normalized
}

type Migration = (payload: Record<string, unknown>) => Record<string, unknown>

// 逐版本搬迁：n → n+1。以后加新版本时在后面续一段，别改老段落。
const MIGRATIONS: Record<number, Migration> = {
  1: (payload) => ({ version: 2, modules: payload }),
}

function detectVersion(payload: unknown): number {
  if (!isRecord(payload)) {
    throw new StorageStructureError('顶层不是条目对象')
  }
  if ('version' in payload) {
    const version = payload.version
    if (typeof version !== 'number' || !Number.isInteger(version)) {
      throw new StorageStructureError('版本号不是整数')
    }
    if (!SUPPORTED_VERSIONS.includes(version) || version > STORAGE_VERSION) {
      throw new StorageVersionError(version)
    }
    return version
  }
  // 没有 version 字段的平铺结构按版本 1 处理
  return 1
}

/** 按版本把存量数据一步步搬到当前结构；认不出的版本直接报出是哪一版对不上。 */
export function migrateToCurrent(payload: unknown): StorageEnvelope {
  let current = payload
  let version = detectVersion(current)
  while (version < STORAGE_VERSION) {
    const migrate = MIGRATIONS[version]
    if (!migrate) {
      throw new StorageVersionError(version)
    }
    current = migrate(current as Record<string, unknown>)
    version += 1
  }
  const envelope = current as StorageEnvelope
  if (envelope.modules !== undefined && !isRecord(envelope.modules)) {
    throw new StorageStructureError('modules 不是条目对象')
  }
  return envelope
}
