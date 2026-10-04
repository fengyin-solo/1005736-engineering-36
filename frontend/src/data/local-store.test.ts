import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  LEGACY_VERSION,
  QUARANTINE_KEY_PREFIX,
  ROW_HEADERS,
  STORAGE_KEY,
  STORAGE_VERSION,
  normalizeRow,
} from '@/data/schema'
import { MODULE_BY_KEY } from '@/data/modules'
import { SEED_ROWS } from '@/data/seed'
import {
  __reloadForTest,
  allRows,
  listRows,
  migrationReport,
  resetRows,
  saveRows,
  storageVersion,
} from '@/data/local-store'

// ---- 内存版 localStorage ----------------------------------------------------

class MemoryStorage {
  private map = new Map<string, string>()
  getItem(key: string): string | null {
    return this.map.has(key) ? (this.map.get(key) as string) : null
  }
  setItem(key: string, value: string): void {
    this.map.set(key, String(value))
  }
  removeItem(key: string): void {
    this.map.delete(key)
  }
  clear(): void {
    this.map.clear()
  }
  keys(): string[] {
    return [...this.map.keys()]
  }
}

let storage: MemoryStorage

function installStorage(): void {
  storage = new MemoryStorage()
  vi.stubGlobal('window', { localStorage: storage })
  __reloadForTest()
}

function seedRaw(value: unknown): void {
  storage.setItem(STORAGE_KEY, JSON.stringify(value))
  __reloadForTest()
}

beforeEach(() => {
  installStorage()
})

describe('normalizeRow：按同一定义补填且保持字段次序', () => {
  const meta = MODULE_BY_KEY.get('substation')!

  it('老行缺新字段时，按定义次序把缺的字段补在末尾', () => {
    // 模拟字段还没加全时的存量行：只有前三个业务字段，且没有 abnormal
    const legacy = {
      id: 7,
      status: '运行中',
      pending: false,
      站名: '北郊站',
      电压等级: '110kV',
      所属供电所: '北郊供电所',
    }
    const { row, refilledFields, invalid } = normalizeRow(legacy, meta)
    expect(invalid).toBe(false)
    expect(row.abnormal).toBe(false) // 整列缺失也要补出来
    expect(row.主变台数).toBe('')
    expect(row.投运日期).toBe('')
    expect(row.站长).toBe('')
    expect(row.接线方式).toBe('')
    expect(row.站点状态).toBe('')
    // 缺失字段恰好是这 6 个（5 个业务字段 + abnormal）
    expect(refilledFields).toEqual(
      expect.arrayContaining(['abnormal', '主变台数', '投运日期', '站长', '接线方式', '站点状态']),
    )
    // 发生补填 -> 退回待办
    expect(row.pending).toBe(true)
  })

  it('保留原有字段的先后次序，不重排', () => {
    const legacy = {
      id: 1,
      status: '待投运',
      pending: true,
      abnormal: false,
      所属供电所: 'x',
      站名: 'y', // 故意把次序倒过来
      电压等级: 'z',
    }
    const { row } = normalizeRow(legacy, meta)
    const keys = Object.keys(row)
    expect(keys.slice(0, 4)).toEqual(['id', 'status', 'pending', 'abnormal'])
    const business = keys.slice(4).filter((k) => ['所属供电所', '站名', '电压等级'].includes(k))
    expect(business).toEqual(['所属供电所', '站名', '电压等级'])
  })

  it('存量值是非法值时退回补填，不抛出', () => {
    const legacy = {
      id: '不是编号',
      status: '',
      pending: 'yes',
      abnormal: 1,
      站名: { nested: 'object' },
      电压等级: null,
    }
    const { row, refilledFields } = normalizeRow(legacy, meta)
    expect(Number.isNaN(row.id)).toBe(true) // 非法编号由桶级逻辑统一分配
    expect(row.status).toBe(meta.statuses[0]) // 空状态退回模块初始状态
    expect(refilledFields).toContain('id')
    expect(refilledFields).toContain('status')
    expect(row.站名).toBe('')
    expect(row.电压等级).toBe('')
    expect(row.pending).toBe(true) // 非法布尔按待办补
    expect(row.abnormal).toBe(false)
  })

  it('数字状态会按字符串保留而不是误补填', () => {
    const { row, refilledFields } = normalizeRow(
      { id: 1, status: 0, pending: true, abnormal: false },
      meta,
    )
    expect(row.status).toBe('0')
    expect(refilledFields).not.toContain('status')
  })

  it('源数据不是对象记录时标记为坏行，由桶级丢弃', () => {
    expect(normalizeRow('garbage', meta).invalid).toBe(true)
    expect(normalizeRow(null, meta).invalid).toBe(true)
    expect(normalizeRow([1, 2], meta).invalid).toBe(true)
  })
})

describe('读存储：按版本搬迁存量数据', () => {
  it('无版本号的 v1 纯 map 会搬到带版本的信封', () => {
    const legacyMap = {
      substation: [
        {
          id: 1,
          status: '运行中',
          pending: false,
          // abnormal 整列缺失
          站名: '老站',
          电压等级: '220kV',
          所属供电所: '某供电所',
          主变台数: '2',
          投运日期: '2020-01-01',
          站长: '张三',
          接线方式: '单母线',
          站点状态: '运行',
        },
      ],
    }
    seedRaw(legacyMap)

    const rows = listRows('substation')
    expect(rows).toHaveLength(1)
    expect(rows[0].abnormal).toBe(false)
    // abnormal 整列是后加的：这行被补填后落进待办清单，等值班员复核
    expect(rows[0].pending).toBe(true)
    expect(migrationReport()!.repairedRows.substation).toBe(1)

    const report = migrationReport()!
    expect(report.fromVersion).toBe(LEGACY_VERSION)
    expect(report.toVersion).toBe(STORAGE_VERSION)
    expect(report.migrated).toBe(true)

    // 搬迁结果立即落库：刷新再读字段一致
    const onDisk = JSON.parse(storage.getItem(STORAGE_KEY)!)
    expect(onDisk.version).toBe(STORAGE_VERSION)
    __reloadForTest()
    expect(listRows('substation')[0].站名).toBe('老站')
    expect(migrationReport()?.issues).toHaveLength(0) // 第二次读不应再重复登记
  })

  it('老行缺字段时补填并计入该模块的待办清单', () => {
    seedRaw({
      version: STORAGE_VERSION,
      modules: {
        substation: [
          {
            id: 1,
            status: '运行中',
            pending: false,
            abnormal: false,
            站名: '只录了一半',
            // 其余 7 个字段全缺
          },
        ],
      },
    })
    const row = listRows('substation')[0]
    expect(row.电压等级).toBe('')
    expect(row.站点状态).toBe('')
    expect(row.pending).toBe(true) // 补填 -> 待办

    const report = migrationReport()!
    expect(report.repairedRows.substation).toBe(1)
    const refillIssue = report.issues.find((i) => i.kind === 'field-refilled')!
    expect(refillIssue.module).toBe('substation')
    expect(refillIssue.fields).toContain('电压等级')
  })

  it('某一行坏掉只丢这一行，同一模块的其他行保留', () => {
    seedRaw({
      version: STORAGE_VERSION,
      modules: {
        substation: [
          { id: 1, status: '运行中', pending: false, abnormal: false, 站名: '好行1' },
          '我是坏行',
          null,
          { id: 3, status: '检修中', pending: false, abnormal: false, 站名: '好行3' },
        ],
      },
    })
    const rows = listRows('substation')
    expect(rows.map((r) => r.站名)).toEqual(['好行1', '好行3'])
    expect(migrationReport()!.issues.some((i) => i.kind === 'row-dropped')).toBe(true)
  })

  it('一个模块的桶不是数组，只重置这一块并指明版本，其他模块不动', () => {
    seedRaw({
      version: STORAGE_VERSION,
      modules: {
        substation: '整块被写坏了',
        breaker: [
          { id: 9, status: '运行中', pending: false, abnormal: false, 设备编号: 'BR-009' },
        ],
      },
    })
    // substation 回退到种子，字段按种子补齐
    expect(listRows('substation')[0].站名).toBeTruthy()
    // breaker 自己录的数据还在
    expect(listRows('breaker')[0].设备编号).toBe('BR-009')
    const issue = migrationReport()!.issues.find((i) => i.kind === 'bucket-replaced')!
    expect(issue.module).toBe('substation')
    expect(issue.fromVersion).toBe(STORAGE_VERSION)
  })

  it('认不出的高版本不整块丢弃：能搬的照搬并登记是哪一版对不上', () => {
    seedRaw({
      version: 99,
      modules: {
        substation: [{ id: 1, status: '运行中', pending: false, abnormal: false }],
        futurebiz: [{ future: true }],
      },
    })
    expect(listRows('substation')[0].status).toBe('运行中')
    const report = migrationReport()!
    const mismatch = report.issues.find((i) => i.kind === 'version-mismatch')!
    expect(mismatch.fromVersion).toBe(99)
    expect(mismatch.detail).toContain('v99')
    // 不认识的业务分块原样保留
    expect(allRows().futurebiz).toEqual([{ future: true }])
    // 落库版本抬到当前版本（数据已尽可能搬运），原始未识别字段随桶保留
    expect(JSON.parse(storage.getItem(STORAGE_KEY)!).
      version).toBe(STORAGE_VERSION)
  })

  it('整块 JSON 解析失败：原文隔离留底，再用种子补位，不覆盖其他数据场景', () => {
    storage.setItem(STORAGE_KEY, '{这不是JSON')
    __reloadForTest()
    const rows = listRows('substation')
    expect(rows.length).toBeGreaterThan(0) // 有种子兜底
    const report = migrationReport()!
    expect(report.issues[0].kind).toBe('unparseable')
    expect(report.quarantineKey).toBeTruthy()
    const quarantineKeys = storage.keys().filter((k) => k.startsWith(QUARANTINE_KEY_PREFIX))
    expect(quarantineKeys).toHaveLength(1)
    expect(storage.getItem(quarantineKeys[0])).toBe('{这不是JSON')
  })

  it('信封形状认不出来时整桶隔离留底，而不是静默扔掉', () => {
    storage.setItem(STORAGE_KEY, JSON.stringify([1, 2, 3]))
    __reloadForTest()
    const report = migrationReport()!
    expect(report.issues.some((i) => i.kind === 'shape-mismatch')).toBe(true)
    expect(report.quarantineKey).toBeTruthy()
    expect(listRows('substation').length).toBe(SEED_ROWS.substation.length)
  })

  it('老数据缺少整个新模块时，只用种子补这一块，老模块数据不动', () => {
    // v1 纯 map：老浏览器里只有当时已存在的 substation，没有后来新增的 safetytool
    seedRaw({
      substation: [{ id: 1, status: '运行中', pending: false, abnormal: false, 站名: '独苗' }],
    })
    expect(listRows('substation')[0].站名).toBe('独苗')
    expect(listRows('safetytool').length).toBe(SEED_ROWS.safetytool.length)
  })
})

describe('回收只动当前这一块业务', () => {
  it('resetRows 只覆盖目标模块，其他模块录好的数据原样保留', () => {
    seedRaw({
      version: STORAGE_VERSION,
      modules: {
        substation: [{ id: 1, status: '运行中', pending: false, abnormal: false, 站名: '我的录入' }],
        breaker: [{ id: 2, status: '运行中', pending: false, abnormal: false, 设备编号: 'BR-我的' }],
      },
    })
    resetRows('substation')
    expect(listRows('substation').some((r) => r.站名 === '我的录入')).toBe(false)
    expect(listRows('breaker')[0].设备编号).toBe('BR-我的') // 别人录的没被擦
    const onDisk = JSON.parse(storage.getItem(STORAGE_KEY)!)
    expect(onDisk.modules.breaker[0].设备编号).toBe('BR-我的')
    expect(onDisk.version).toBe(STORAGE_VERSION)
  })

  it('saveRows 只写对应分块，落库字段次序与读出来一致', () => {
    const rows = listRows('substation')
    const edited = [{ ...rows[0], 站名: '刷新一致性' }]
    saveRows('substation', edited)
    __reloadForTest()
    expect(listRows('substation')[0].站名).toBe('刷新一致性')
    expect(Object.keys(listRows('substation')[0])).toEqual(Object.keys(edited[0]))
  })

  it('某模块被重新写入（复核/回收）后，挂在它上面的补填待办核销，其他模块保留', () => {
    seedRaw({
      version: STORAGE_VERSION,
      modules: {
        substation: [{ id: 1, status: '运行中', pending: false, abnormal: false }],
        breaker: [{ id: 1, status: '运行中', pending: false, abnormal: false }],
      },
    })
    expect(migrationReport()!.repairedRows.substation).toBe(1)
    expect(migrationReport()!.repairedRows.breaker).toBe(1)
    saveRows('substation', listRows('substation'))
    expect(migrationReport()!.repairedRows.substation).toBeUndefined()
    expect(migrationReport()!.repairedRows.breaker).toBe(1)
  })
})

describe('首次使用与版本常量', () => {
  it('空存储播种为当前版本的信封', () => {
    expect(storage.getItem(STORAGE_KEY)).toBeNull()
    allRows()
    const onDisk = JSON.parse(storage.getItem(STORAGE_KEY)!)
    expect(onDisk.version).toBe(STORAGE_VERSION)
    expect(storageVersion()).toBe(STORAGE_VERSION)
  })

  it('种子本身就是规范结构：不触发任何补填，字段次序与定义一致', () => {
    for (const meta of MODULE_BY_KEY.values()) {
      const rows = SEED_ROWS[meta.key] ?? []
      for (const seedRow of rows) {
        // 读到的每一行键次序恰好是「头部字段 + 定义里的字段」
        expect(Object.keys(seedRow)).toEqual([...ROW_HEADERS, ...meta.fields])
      }
    }
  })
})
