import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  invalidateCache,
  listRows,
  resetRows,
  saveRows,
  storageKey,
  storageVersion,
} from './local-store'
import { MODULE_BY_KEY } from './modules'
import { SEED_ROWS } from './seed'
import {
  BASE_FIELDS,
  canonicalFields,
  STORAGE_VERSION,
  StorageStructureError,
  StorageVersionError,
} from './schema'
import type { EntryRow } from './types'

// 用内存版 localStorage 模拟浏览器环境，每个用例一份干净的
function createLocalStorageMock() {
  const map = new Map<string, string>()
  return {
    map,
    getItem: (key: string) => (map.has(key) ? (map.get(key) as string) : null),
    setItem: (key: string, value: string) => {
      map.set(key, String(value))
    },
    removeItem: (key: string) => {
      map.delete(key)
    },
    clear: () => map.clear(),
  }
}

let storage: ReturnType<typeof createLocalStorageMock>

function storedEnvelope() {
  const raw = storage.map.get(storageKey())
  expect(raw).toBeTruthy()
  return JSON.parse(raw as string) as { version: number; modules: Record<string, EntryRow[]> }
}

beforeEach(() => {
  storage = createLocalStorageMock()
  vi.stubGlobal('window', { localStorage: storage })
  invalidateCache()
})

describe('首次播种', () => {
  it('落库带当前结构版本，行字段次序与模块定义一致', () => {
    const rows = listRows('substation')
    expect(rows).toHaveLength(SEED_ROWS.substation.length)
    const envelope = storedEnvelope()
    expect(envelope.version).toBe(STORAGE_VERSION)
    for (const key of MODULE_BY_KEY.keys()) {
      expect(Object.keys(envelope.modules[key][0])).toEqual([
        ...BASE_FIELDS,
        ...MODULE_BY_KEY.get(key)!.fields,
      ])
    }
  })
})

describe('旧版本存量数据迁移', () => {
  it('版本 1 的平铺结构搬到当前版本：缺的字段按次序补齐，异常标记补 false', () => {
    const legacy = {
      substation: [
        { id: 7, status: '运行中', pending: false, 站名: '老站' },
        {
          id: 9,
          status: '已退役',
          pending: false,
          abnormal: false,
          站名: '完整站',
          电压等级: '110kV',
          所属供电所: '城东所',
          主变台数: '2',
          投运日期: '2020-01-01',
          站长: '张三',
          接线方式: '单母',
          站点状态: '在运',
        },
      ],
    }
    storage.map.set(storageKey(), JSON.stringify(legacy))
    invalidateCache()

    const rows = listRows('substation')
    expect(rows).toHaveLength(2)

    // 缺字段的行：按定义次序补齐空串，abnormal 补 false，整行退回待办清单
    const moved = rows[0]
    expect(moved.id).toBe(7)
    expect(moved.status).toBe('运行中')
    expect(moved.abnormal).toBe(false)
    expect(moved['站名']).toBe('老站')
    expect(moved['电压等级']).toBe('')
    expect(moved['站点状态']).toBe('')
    expect(moved.pending).toBe(true)
    expect(Object.keys(moved)).toEqual(canonicalFields('substation'))

    // 本来就完整的行：原样搬过来，不动它的待办标记
    const intact = rows[1]
    expect(intact.pending).toBe(false)
    expect(intact['站名']).toBe('完整站')

    // 搬完立刻按当前版本落库，其它模块用种子补齐
    const envelope = storedEnvelope()
    expect(envelope.version).toBe(STORAGE_VERSION)
    expect(envelope.modules.breaker).toHaveLength(SEED_ROWS.breaker.length)
  })

  it('存量字段写成非法值时退回补填：非法值清空、整行标待办，字段次序不变', () => {
    const legacy = {
      defect: [
        {
          id: 3,
          status: '处理中',
          pending: false,
          abnormal: false,
          缺陷编号: 'DEFE-9001',
          缺陷设备: { 坏: '值' },
          缺陷等级: ['严重'],
          缺陷描述: null,
          发现人: '李四',
          处理期限: '2026-09-10',
          处理人: '王五',
          缺陷状态: '处理中',
        },
      ],
    }
    storage.map.set(storageKey(), JSON.stringify(legacy))
    invalidateCache()

    const [row] = listRows('defect')
    expect(row['缺陷编号']).toBe('DEFE-9001')
    expect(row['缺陷设备']).toBe('')
    expect(row['缺陷等级']).toBe('')
    expect(row['缺陷描述']).toBe('')
    expect(row['发现人']).toBe('李四')
    expect(row.pending).toBe(true)
    expect(Object.keys(row)).toEqual(canonicalFields('defect'))
  })
})

describe('认不出的结构', () => {
  it('版本号对不上时报出是哪一版，存量数据原样保留', () => {
    const raw = JSON.stringify({ version: 99, modules: {} })
    storage.map.set(storageKey(), raw)
    invalidateCache()

    expect(() => listRows('substation')).toThrowError(StorageVersionError)
    expect(() => listRows('substation')).toThrowError(/99/)
    expect(storage.map.get(storageKey())).toBe(raw)
  })

  it('内容损坏时报结构错误，存量数据原样保留', () => {
    storage.map.set(storageKey(), 'not-json{{')
    invalidateCache()

    expect(() => listRows('substation')).toThrowError(StorageStructureError)
    expect(storage.map.get(storageKey())).toBe('not-json{{')
  })
})

describe('读写一致', () => {
  it('刷新后读到的字段与落库那份一致', () => {
    const rows: EntryRow[] = [
      {
        id: 1,
        status: '待巡视',
        pending: true,
        abnormal: false,
        巡视编号: 'PATR-1001',
        巡视变电站: '城南站',
        巡视路线: '一线',
        巡视人: '赵六',
        巡视日期: '2026-10-01',
        发现缺陷数: '0',
        处理情况: '无',
        巡视状态: '待巡视',
      },
    ]
    saveRows('patrol', rows)

    // 清掉内存缓存模拟刷新，重新从 localStorage 读
    invalidateCache()
    const reread = listRows('patrol')
    expect(reread).toEqual(rows)
    expect(storedEnvelope().modules.patrol).toEqual(reread)
    expect(storedEnvelope().version).toBe(storageVersion())
  })
})

describe('回收', () => {
  it('只重置当前模块，其它模块已录好的数据原样保留', () => {
    const mine: EntryRow[] = [
      {
        id: 1,
        status: '待核查',
        pending: true,
        abnormal: false,
        核查编号: 'METE-8001',
        计量点名称: '一站一点',
        电能表编号: 'MT-01',
        互感器变比: '100/5',
        误差值: '0.1',
        核查人: '钱七',
        核查日期: '2026-10-02',
        核查状态: '待核查',
      },
    ]
    saveRows('meteringcheck', mine)
    saveRows('patrol', [])

    resetRows('patrol')

    expect(listRows('patrol')).toEqual(
      (SEED_ROWS.patrol as EntryRow[]).map((row) => ({ ...row })),
    )
    expect(listRows('meteringcheck')).toEqual(mine)
    expect(storedEnvelope().modules.meteringcheck).toEqual(mine)
  })
})
