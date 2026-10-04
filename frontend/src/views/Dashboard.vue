<template>
  <section class="page">
    <header class="page-head">
      <div>
        <h2>运营概览</h2>
        <p class="page-desc">汇总各业务模块的关键指标，先看总量再看异常。</p>
      </div>
      <div class="page-actions">
        <button class="btn" type="button" @click="refresh">重新统计</button>
      </div>
    </header>

    <div v-if="migration && migration.issues.length" class="migration-banner">
      <p class="migration-title">
        本地存储结构由 v{{ migration.fromVersion ?? '未知版本' }} 搬迁到 v{{ migration.toVersion }}
        ，共登记 {{ migration.issues.length }} 条对不上的问题（未删除任何业务数据）
      </p>
      <ul class="migration-list">
        <li v-for="(item, index) in migration.issues" :key="index" class="migration-item">
          <span class="migration-kind">{{ kindLabel(item.kind) }}</span>
          {{ item.detail }}
        </li>
      </ul>
    </div>

    <div class="stat-row">
      <article v-for="card in cards" :key="card.label" class="stat-card">
        <span class="stat-label">{{ card.label }}</span>
        <strong class="stat-value">{{ card.value }}</strong>
      </article>
    </div>
    <table class="data-table">
      <thead>
        <tr>
          <th>业务模块</th>
          <th>今日新增</th>
          <th>待处理</th>
          <th>异常量</th>
          <th>升级补填待复核</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in moduleRows" :key="row.name">
          <td>{{ row.name }}</td>
          <td>{{ row.created }}</td>
          <td>{{ row.pending }}</td>
          <td>{{ row.abnormal }}</td>
          <td>{{ row.repaired }}</td>
        </tr>
      </tbody>
    </table>
    <footer class="page-foot">
      <span>数据保存在本机浏览器里（结构版本 v{{ storageVersion }}），换浏览器或清缓存会回到示例数据</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue'

import { loadOverview, storageMigrationReport, storageVersionLabel } from '@/api/local-service'
import type { MigrationReport } from '@/data/schema'
import type { OverviewResult } from '@/data/types'

type OverviewRow = OverviewResult['modules'][number] & { repaired: number }

const cards = ref<OverviewResult['cards']>([])
const moduleRows = ref<OverviewRow[]>([])
const migration = ref<MigrationReport | null>(null)
const storageVersion = ref(storageVersionLabel())

const KIND_LABELS: Record<string, string> = {
  unparseable: '无法解析',
  'shape-mismatch': '结构对不上',
  'version-mismatch': '版本对不上',
  'bucket-replaced': '分块重置',
  'row-dropped': '坏行剔除',
  'field-refilled': '字段补填',
}

function kindLabel(kind: string): string {
  return KIND_LABELS[kind] ?? kind
}

function refresh() {
  const payload = loadOverview()
  cards.value = payload.cards
  const report = storageMigrationReport()
  migration.value = report
  moduleRows.value = payload.modules.map((row) => ({
    ...row,
    repaired: report?.repairedRows[row.key] ?? 0,
  }))
}

onMounted(refresh)
</script>
