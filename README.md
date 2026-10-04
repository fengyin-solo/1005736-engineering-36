# 变电站继电保护定值整定与二次设备检修管理平台

面向变电站台账、保护装置、定值整定与核对、二次回路检查、保护校验、故障录波分析、主变检修与直流系统监测的一体化电网二次设备运维管理工作台。

这是一个**纯前端**管理平台：Vue 3 + Vite + TypeScript，仓库里没有后端服务。业务数据由
`frontend/src/data/` 下的本地数据层提供：首次打开用示例数据播种，之后的登记、筛选与状态流转
结果都持久化在浏览器 `localStorage` 里，刷新或重开浏览器都还在。dev server 已关掉自动打开页面，
启动后按终端打印的地址手工打开。

本地存储是**带结构版本**的（当前 `v2`，定义集中在 `frontend/src/data/schema.ts`）：读取时会按
版本把存量数据逐模块、逐行搬到当前结构，新增字段按定义次序补齐、字段顺序保持原样；补填过的行会
退回该模块的待办清单。遇到认不出的版本或结构，不会整块扔掉，而是登记清楚是哪一版对不上并把原文
隔离留底（`localStorage` 里 `substation-protection:quarantine:*`）。迁移问题汇总展示在「运营概览」。

## 目录结构

```text
.
├── frontend/                 Vue 3 + Vite + TypeScript 前端（唯一运行单元）
│   ├── src/views/            每个业务模块一个页面
│   ├── src/api/local-service.ts   本地数据服务：列表、筛选、动作流转、导出、回收
│   ├── src/data/             模块元数据 / 结构版本定义 / 示例数据 / localStorage 持久化
│   │   ├── modules.ts        字段、状态、动作的唯一来源（页面与存储共用）
│   │   ├── schema.ts         存储信封、版本号、逐行补填/搬迁规则
│   │   ├── local-store.ts    按版本读取、隔离留底、分模块写入与回收
│   │   └── seed.ts           示例数据
│   ├── src/stores/           会话与筛选状态
│   └── vite.config.ts        dev server 配置（open: false，无 /api 代理）
├── .gitignore
└── docker-compose.yml
```

## 启动

本地开发环境一条命令跑通（依赖没装齐会先自动安装，再起 dev server）：

```bash
make dev
```

或在 `frontend/` 下分别执行：

```bash
cd frontend
npm install
npm run dev
```

前端默认监听 `http://127.0.0.1:5173/`，dev server 不会自动打开浏览器，需要自己访问。

测试与生产构建：

```bash
make test     # 或 cd frontend && npm test
make build    # 或 cd frontend && npm run build
```

## 业务模块

| 模块 | 目录 | 业务对象 | 主要字段 |
| --- | --- | --- | --- |
| 变电站台账 | `substation` | 变电站 | 站名、电压等级、所属供电所 |
| 保护装置台账 | `protectiondevice` | 保护装置 | 装置编号、所属间隔、装置型号 |
| 定值整定 | `settingvalue` | 定值单 | 定值单号、所属装置、定值项目 |
| 定值核对 | `settingcheck` | 核对记录 | 核对编号、所属变电站、装置名称 |
| 二次回路检查 | `secondarycircuit` | 回路检查记录 | 检查编号、所属间隔、回路类别 |
| 保护校验 | `relaytest` | 校验记录 | 校验编号、装置名称、校验项目 |
| 故障录波 | `faultrecord` | 录波记录 | 录波编号、故障线路、故障类型 |
| 保护动作统计 | `tripstat` | 动作统计 | 统计编号、所属线路、动作次数 |
| 主变检修 | `transformermaint` | 主变检修记录 | 检修编号、主变名称、检修类别 |
| 断路器维护 | `breaker` | 断路器 | 设备编号、所属间隔、断路器型号 |
| 直流系统监测 | `dcsystem` | 直流监测记录 | 监测编号、所属变电站、蓄电池组号 |
| 绝缘试验 | `insulationtest` | 试验记录 | 试验编号、试验设备、试验项目 |
| 缺陷处置 | `defect` | 缺陷记录 | 缺陷编号、缺陷设备、缺陷等级 |
| 工作票许可 | `workpermit` | 工作票 | 工作票号、工作任务、所属变电站 |
| 设备巡视 | `patrol` | 巡视记录 | 巡视编号、巡视变电站、巡视路线 |
| 计量装置核查 | `meteringcheck` | 核查记录 | 核查编号、计量点名称、电能表编号 |
| 定值审批 | `settingapprove` | 审批单 | 审批单号、关联定值单、审批层级 |
| 安全工器具检定 | `safetytool` | 安全工器具 | 工器具编号、工器具名称、所属班组 |

## 约定

- 每个模块的页面在 `frontend/src/views/<模块>/index.vue`，页面只负责渲染，读写统一走
  `frontend/src/api/local-service.ts`；页面展示的字段直接取 `meta.fields`，不再各写一份。
- 字段、状态、动作与流转目标集中在 `frontend/src/data/modules.ts`；示例数据在
  `frontend/src/data/seed.ts`；存储信封、版本号与补填/搬迁规则集中在
  `frontend/src/data/schema.ts`，落库结构与读取校验出自同一定义。
- 给数据行增删字段后：在 `modules.ts` 改字段定义，抬高 `schema.ts` 的 `STORAGE_VERSION`，
  老浏览器下次读取会自动搬迁；存量字段写成非法值时退回补填并保留原有字段顺序。
- 状态流转只允许在 `local-service.ts` 里改，页面组件不做业务判断。
- 「回收本模块数据」只重置当前这一块业务，其他模块录好的内容不动；想回到全部初始数据，
  清掉浏览器里 `substation-protection:entries` 这一项（`substation-protection:quarantine:*`
  是搬迁时的隔离留底，可另行清理），或调用 `resetModule(模块)`。
