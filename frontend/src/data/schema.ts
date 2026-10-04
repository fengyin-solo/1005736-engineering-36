import { MODULE_BY_KEY, MODULES } from './modules'
import type { EntryRow, ModuleMeta } from './types'

/**
 * 本地存储结构的唯一定义：落库的信封、读取时的补填顺序、默认值都从这里出，
 * 页面渲染与 local-store 的搬迁逻辑不允许再各写一份字段表。
 */

export const STORAGE_KEY = 'substation-protection:entries'
/** 搬迁后写入的结构版本：每次给数据行增删字段都要抬版本并登记搬迁规则。 */
export const STORAGE_VERSION = 2
/** 最初没有版本号的存量数据按这一版处理。 */
export const LEGACY_VERSION = 1
/** 认不出 / 解析失败的原始数据挪到这个前缀下留底，绝不直接覆盖。 */
export const QUARANTINE_KEY_PREFIX = 'substation-protection:quarantine:'

/** 每条数据行固定的头部字段，顺序即落库次序。 */
export const ROW_HEADERS = ['id', 'status', 'pending', 'abnormal'] as const

/** 版本化的存储信封：version 标结构，modules 里按业务模块 key 各放各的行。 */
export type StoredEnvelope = {
  version: number
  modules: Record<string, EntryRow[]>
}

export type IssueKind =
  | 'unparseable'
  | 'shape-mismatch'
  | 'version-mismatch'
  | 'bucket-replaced'
  | 'row-dropped'
  | 'field-refilled'

export type MigrationIssue = {
  kind: IssueKind
  /** 对不上的那一版；能确定是模块级问题时带上模块 key。 */
  fromVersion: number | null
  module: string | null
  detail: string
  /** 该行被退回补填的字段名（field-refilled 时使用）。 */
  fields: string[]
}

export type MigrationReport = {
  fromVersion: number | null
  toVersion: number
  migrated: boolean
  /** 触发补填、因此落进各模块待办清单的数据行，按模块 key 归类。 */
  repairedRows: Record<string, number>
  issues: MigrationIssue[]
  quarantineKey: string | null
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function defaultStatus(meta: ModuleMeta | undefined): string {
  return meta?.statuses[0] ?? ''
}

/** 补填时的空值：新增字段统一补空字符串，跟页面上「—」的展示约定一致。 */
export function emptyFieldValue(): string {
  return ''
}

export type NormalizedRow = {
  row: EntryRow
  /** 这一行哪些字段是退回补填的，按字段登记，便于落到待办清单。 */
  refilledFields: string[]
  /** true 表示源数据根本不是一行记录，调用方应丢弃而不是保留。 */
  invalid: boolean
}

/**
 * 把存量的一行搬成当前结构：
 * - 原有字段值合法就原样保留，且保持它在源数据里的先后次序；
 * - 新增 / 缺失 / 非法的字段按定义的次序补默认值；
 * - 任一字段发生补填，这一行就退回待办（pending=true），等值班员复核。
 */
export function normalizeRow(raw: unknown, meta: ModuleMeta | undefined): NormalizedRow {
  if (!isPlainRecord(raw)) {
    return {
      row: { id: NaN, status: '', pending: true, abnormal: false },
      refilledFields: [],
      invalid: true,
    }
  }

  const refilled: string[] = []
  const fill = (field: string) => refilled.push(field)

  // id：必须是能当编号用的有限数值
  let id: number
  const rawId = raw['id']
  const numericId = typeof rawId === 'number' ? rawId : Number(rawId)
  if (rawId !== undefined && rawId !== null && Number.isFinite(numericId)) {
    id = numericId
  } else {
    id = NaN
    fill('id')
  }

  // status：认不出的状态退回该模块的初始状态
  let status: string
  if (typeof raw['status'] === 'string' && raw['status'].trim() !== '') {
    status = raw['status']
  } else if (
    typeof raw['status'] === 'number' &&
    Number.isFinite(raw['status'])
  ) {
    status = String(raw['status'])
  } else {
    status = defaultStatus(meta)
    fill('status')
  }

  // pending / abnormal：老结构里整列缺失或写成非法值时，按布尔语义补
  let pending: boolean
  if (typeof raw['pending'] === 'boolean') {
    pending = raw['pending']
  } else {
    pending = true
    fill('pending')
  }
  let abnormal: boolean
  if (typeof raw['abnormal'] === 'boolean') {
    abnormal = raw['abnormal']
  } else {
    abnormal = false
    fill('abnormal')
  }

  const canonicalFields = meta?.fields ?? []
  const usedKeys = new Set<string>(ROW_HEADERS)

  const businessPairs: [string, string | number | boolean][] = []
  for (const [key, value] of Object.entries(raw)) {
    if (usedKeys.has(key)) {
      continue
    }
    usedKeys.add(key)
    if (canonicalFields.includes(key)) {
      if (value === null || typeof value === 'object') {
        // 业务字段落了非法值：退回补填空串，保留字段原有位置
        businessPairs.push([key, emptyFieldValue()])
        fill(key)
      } else {
        businessPairs.push([key, value as string | number | boolean])
      }
    } else {
      // 认得出的行里多出来的字段：不丢，原样带在后面
      if (value === null || typeof value === 'object') {
        businessPairs.push([key, emptyFieldValue()])
        fill(key)
      } else {
        businessPairs.push([key, value as string | number | boolean])
      }
    }
  }

  // 结构里定义了、但这一行还没有的字段，按定义次序补在末尾
  for (const field of canonicalFields) {
    if (!usedKeys.has(field)) {
      usedKeys.add(field)
      businessPairs.push([field, emptyFieldValue()])
      fill(field)
    }
  }

  const row: EntryRow = { id, status, pending, abnormal }
  for (const [key, value] of businessPairs) {
    row[key] = value
  }

  if (refilled.length > 0) {
    // 发生过补填的存量行退回待办，等业务人员核对
    row.pending = true
  }

  return { row, refilledFields: refilled, invalid: false }
}

/** id 无法补成编号时由调用方分配的兜底编号生成器。 */
export function nextFallbackId(rows: EntryRow[]): number {
  return rows.reduce((max, row) => Math.max(max, Number(row.id) || 0), 0) + 1
}

export type NormalizedBucket = {
  rows: EntryRow[]
  /** 被丢弃的坏行（源数据不是对象记录）。 */
  dropped: number
  /** 发生过补填的行（含各自补填的字段）。 */
  refilled: { row: EntryRow; fields: string[] }[]
}

/** 把一个业务模块的一整桶数据搬到当前版本；坏行只丢这一行，不连累其他行。 */
export function normalizeBucket(raw: unknown, meta: ModuleMeta | undefined): NormalizedBucket {
  if (!Array.isArray(raw)) {
    // 桶的形状都不对：整块按空数据补填，登记问题后交由调用方决定是否用种子兜底
    return { rows: [], dropped: 0, refilled: [] }
  }

  const rows: EntryRow[] = []
  const refilled: { row: EntryRow; fields: string[] }[] = []
  let dropped = 0
  for (const item of raw) {
    const result = normalizeRow(item, meta)
    if (result.invalid) {
      dropped += 1
      continue
    }
    if (!Number.isFinite(result.row.id)) {
      result.row.id = nextFallbackId(rows)
      if (!result.refilledFields.includes('id')) {
        result.refilledFields.push('id')
      }
    }
    rows.push(result.row)
    if (result.refilledFields.length > 0) {
      refilled.push({ row: result.row, fields: result.refilledFields })
    }
  }
  return { rows, dropped, refilled }
}

export function isKnownModule(key: string): boolean {
  return MODULE_BY_KEY.has(key)
}

export function knownModules(): ModuleMeta[] {
  return MODULES
}
