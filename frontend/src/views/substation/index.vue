<template>
  <section class="page" data-module="substation">
    <header class="page-head">
      <div>
        <h2>变电站台账管理</h2>
        <p class="page-desc">维护变电站，围绕站名、电压等级、所属供电所、主变台数做登记、筛选与状态流转。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记变电站</button>
        <button class="btn" type="button" @click="exportRows">导出变电站台账清单</button>
        <button class="btn danger" type="button" @click="recycleRows">回收本模块数据</button>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <p class="status-legend">
      <span v-for="item in statusSummary" :key="item.status" class="legend-item">
        {{ item.status }}：{{ item.count }}
      </span>
    </p>

    <form class="filter-bar" @submit.prevent="reload">
      <label v-for="field in filterFields" :key="field" class="filter-item">
        <span>{{ field }}</span>
        <input v-model="filters[field]" :placeholder="`按${field}检索`" />
      </label>
      <button class="btn" type="submit">查询</button>
      <button class="btn ghost" type="button" @click="resetFilters">重置条件</button>
    </form>

    <table class="data-table">
      <thead>
        <tr>
          <th v-for="column in columns" :key="column">{{ column }}</th>
          <th>当前状态</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)">
          <td v-for="column in columns" :key="column">{{ row[column] ?? '—' }}</td>
          <td>{{ row.status }}</td>
          <td class="row-actions">
            <button
              v-for="action in actions"
              :key="action"
              class="link"
              type="button"
              @click="runAction(action, row)"
            >
              {{ action }}
            </button>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 2" class="empty-state">暂无变电站台账数据，可先登记变电站</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条变电站台账记录</span>
      <span v-if="repairNotice" class="warn-text">{{ repairNotice }}</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  downloadEntries,
  listEntries,
  moduleRepairCount,
  moduleMeta,
  recycleModule,
  runAction as applyAction,
} from '@/api/local-service'
import type { EntryRow } from '@/data/types'

const meta = moduleMeta('substation')
const columns = meta.fields
const actions = meta.actions
const statuses = meta.statuses
const stats = meta.metrics.map((label: string) => ({ label, value: 0 }))

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const repairNotice = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 3)
const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function recycleRows() {
  const confirmed = window.confirm(`只回收「${meta.name}」这一块的本地数据，其他业务录好的内容不受影响，确认回收？`)
  if (!confirmed) {
    return
  }
  const result = recycleModule(meta.key)
  errorMessage.value = ''
  repairNotice.value = result.message
  reload()
}

function openCreate() {
  errorMessage.value = '变电站登记入口尚未接入审批流'
}

function runAction(action: string, row: EntryRow) {
  errorMessage.value = ''
  const result = applyAction(meta.key, Number(row.id), action)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  reload()
}

function reload() {
  errorMessage.value = ''
  try {
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
    const repaired = moduleRepairCount(meta.key)
    repairNotice.value = repaired > 0
      ? `本地存储升级后，本模块有 ${repaired} 行老数据按新结构补填并退回待办，请核对`
      : ''
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '变电站台账列表读取失败'
  }
}

onMounted(reload)
</script>
