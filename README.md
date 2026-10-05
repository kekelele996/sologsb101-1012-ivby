# sologsb101-1012 地震台阵仪器标定与布设台账

面向地震台阵建设与运维班组的纯前端单页应用：把台站布设、仪器安装与逐次标定结果写成可追溯的台账。数据全部保存在浏览器本地（IndexedDB），不依赖任何后端服务或外部接口。

## 一、Docker 一键启动（推荐）

```bash
cp .env.example .env && docker compose up -d --build
```

启动完成后访问：**http://localhost:22812**

常用命令：

```bash
docker compose ps                 # 查看容器状态
docker compose logs -f frontend   # 查看 nginx 访问日志
docker compose down               # 停止并移除容器
docker compose up -d --build      # 修改代码后重新构建
```

> 宿主端口由 `.env` 中的 `FRONTEND_PORT` 控制（默认 22812）。
> 容器为纯静态 nginx，无数据库服务、不挂载任何命名卷，可随时删除重建。

## 二、技术栈

| 层次 | 选型 | 说明 |
| --- | --- | --- |
| 框架 | React 18.3（函数组件 + Hooks） | 页面全部 `lazy` 懒加载并 `Suspense` 兜底 |
| 语言 | TypeScript 5.6（strict） | 构建脚本执行 `tsc --noEmit` 类型检查 |
| UI 组件 | Ant Design 5.22 + @ant-design/icons | 中文语言包，表格 / 表单 / Modal / 徽标 |
| 构建 | Vite 5 | 产物 `dist/`，交给 nginx 托管 |
| 状态管理 | Redux Toolkit 2 + react-redux 9 | `arraySlice` / `instrumentSlice` / `calibrationSlice` |
| 路由 | React Router 6（`createBrowserRouter`） | 路径与提示词逐字一致，支持深链刷新 |
| 持久化 | Dexie 4（IndexedDB，库名 `gbseisarray`） | 结构版本 v3 + upgrade 迁移 + liveQuery 订阅 |
| 容器 | node:20-alpine 构建 → nginx:alpine 运行 | 多阶段构建，运行阶段 `chmod -R a+rX` |

## 三、路由与功能模块

| 路由 | 页面 | 消费模型 | 主要交互 |
| --- | --- | --- | --- |
| `/arrays` | 台阵与台站台账 | Array、Station、Instrument | 新建/编辑/删除台阵，按布设日期、运行状态与孔径分档筛选；卡片回显台站数、仪器数与标定合格率，可一键按经纬度重算孔径 |
| `/stations/:id/instruments` | 台站仪器登记与安装位置维护 | Station、Instrument | 新增/编辑/删除台站（经纬度范围校验 + 度分秒显示、基岩类型、高程），登记仪器（类型/型号/序列号**唯一性校验**/安装日期/状态），登记后自动生成下一次标定待办 |
| `/calibrations` | 标定记录台（计量站标定册） | Calibration、Instrument | 录入灵敏度、自噪与脉冲响应结论（按类型区间自动初判）、灵敏度相对**同一序列号上次标定**的变化、批量改结论、灵敏度趋势（按序列号分线）；序列号与档案对不上的标定自动挂起，不回写仪器状态 |
| `/replacements` | 合格评定、更换提醒与两册挂起台账 | Replace、Reconciliation、Calibration、Instrument | 按 365 天标定周期评定（只看当前序列号的标定），超期未标定与不合格仪器高亮；登记更换单（快照旧序列号）并推进状态机（待更换→已更换→已复核），流转到「已更换」时 CAS 回写新序列号并只挂**待标定**；底部挂起台账处理两册对账 |
| `/geometry` | 台阵几何视图与结构版本 | 全部模型 | 实算孔径与台站间距、SVG 几何平面图与辐射距离、按台阵汇总标定结论、结构版本查看、全量 JSON 导入导出 |

带 `:id` 的层级路由在直接深链访问时同样可用：若 IndexedDB 中查不到该台阵，页面渲染 `<RouteMissingPanel>` 友好空态（含「返回台阵台账」与可用 id 快捷跳转），不会白屏。

## 四、目录结构

```
sologsb101-1012/
├── README.md
├── docker-compose.yml          # name: gbseisarray，不写 version
├── Dockerfile                  # 多阶段：node:20-alpine 构建 → nginx:alpine 托管
├── nginx.conf                  # try_files $uri $uri/ /index.html; + gzip
├── .env / .env.example         # COMPOSE_PROJECT_NAME、FRONTEND_PORT
├── .gitignore
└── frontend/
    ├── Dockerfile              # 前端独立构建用（同样多阶段 + chmod -R a+rX）
    ├── nginx.conf              # 前端独立托管用
    ├── .dockerignore
    ├── package.json            # build = tsc --noEmit && vite build
    ├── tsconfig.json
    ├── vite.config.ts
    ├── index.html
    ├── public/favicon.svg
    └── src/
        ├── main.tsx            # Provider + ConfigProvider + RouterProvider
        ├── App.tsx             # 侧边导航 + 顶部上下文条 + 页脚，并启动各表订阅
        ├── types/              # array / station / instrument / calibration / replace / reconcile / filter
        ├── stores/             # arraySlice / instrumentSlice / calibrationSlice / replaceSlice / store.ts
        ├── components/common/  # QualifyTag / FilterBar / StatBadge / EmptyPanel / RouteMissingPanel
        ├── hooks/              # useIdbTable / useCalibHistory
        ├── pages/              # ArrayList / StationInstruments / CalibrationBoard / ReplaceBoard / GeometryView
        ├── router/index.tsx    # 路由表（路径与提示词逐字一致）
        ├── styles/main.css
        └── utils/              # geo.ts（Haversine/孔径）/ db.ts（Dexie 封装）/ ledger.ts（两册分治写入）/ export.ts（导入导出与结论）
```

## 五、本地开发

```bash
cd frontend
npm install
npm run dev        # http://localhost:22812
npm run build      # 类型检查 + 生产构建
npm run preview    # 预览构建产物
```

## 六、数据存储说明

- **存储位置**：浏览器 IndexedDB，库名 `gbseisarray`，当前结构版本 `v3`。读写统一经 `frontend/src/utils/db.ts` 封装，页面组件不直接触碰 Dexie 实例。
- **数据表**：`arrays`（台阵）、`stations`（台站）、`instruments`（仪器档案）、`calibrations`（计量站标定册，带序列号快照与对账状态）、`replaces`（运维班更换册，带旧/新序列号快照）、`reconciliations`（两册挂起台账）。
- **两册分治与并发回写（v3 核心）**：计量站管标定记录、灵敏度与响应结论；运维班管更换单、新序列号与更换进度。两侧写入统一走 `utils/ledger.ts`：
  - **序列号快照**：每条标定记录保存录入时的序列号；仪器换号后，旧序列号的历次标定仍归旧序列号，新序列号的趋势、首次标定判定都只统计本序列号的记录。
  - **新序列号先挂待标定**：更换单推进到「已更换」时，在同一 IndexedDB 事务内读档并 CAS 回写新序列号，仪器只置「**待标定**」；等该序列号**自己的第一次标定**录完，才由计量站按结论定状态（合格→在用，不合格→待标定）。
  - **对不上先挂起**：标定序列号与档案不一致、新序列号被占用、更换单基于旧档案三种情形都只登记 `reconciliations` 挂起记录——标定照存为「待确认」、更换单维持原状态、仪器字段一个都不改，等双方在更换提醒页底部挂起台账确认放行或撤销。
  - **丢更新防护**：两侧都在重叠作用域的事务内做「按序列号条件更新（CAS）」，IndexedDB 对重叠事务串行化，后到的陈旧写入无法盖掉先到的写入（新序列号不会再被旧表单的保存盖丢）。
  - **各自只重试 / 修改自己的册子**：计量侧事务遇瞬态存储错误只重试自己的标定写入（`withMetrologyRetry`，作用域不含 `replaces`）；运维班已认下的更换单计量侧不动，反之亦然。
- **升级迁移**：`v1` 初版结构；`v2` 补齐索引与必填字段；`v3` 新增标定序列号快照 / 对账状态、更换单旧序列号与 `reconciliations` 挂起表，升级时历史标定按仪器当前序列号回填快照、历史更换单回填旧序列号。调整字段结构时递增 `DB_VERSION` 并补迁移。
- **首屏播种**：`initDatabase()` 在 `arrays` 表为空时执行幂等播种（2 个台阵 / 5 个台站 / 8 台仪器 / 12 条标定 / 3 条更换 / 1 条挂起），刻意覆盖：不合格标定、超期未标定、换号后等待首次标定、新序列号首标合格转在用、序列号录错挂起等场景。
- **实时同步**：`utils/db.ts` 的 `watchTable()` 基于 Dexie `liveQuery` 订阅表变化，`App.tsx` 挂载时启动订阅并把数据 dispatch 到 Redux slice（标定 / 更换各一个 slice），页面只读 selector。
- **业务规则**：标定周期 365 天；响应结论自动初判规则为「灵敏度落在类型区间内（宽频带 800~3000、短周期 100~800、强震 0.1~5）且自噪 ≤ 3.5」，最终以标定报告为准；仪器序列号全局唯一；更换状态机为 待更换 → 已更换 → 已复核。
- **备份与恢复**：`/geometry` 页可导出包含六张表的 JSON 快照，支持「覆盖导入」与「追加导入（重新分配 id，含挂起记录的关联重映射）」；旧版五表备份可正常导入（挂起表按空数组处理）。备份时间写入 `localStorage`，页脚与几何页均展示结构版本号。
- **离线可用**：应用为纯静态资源，无任何网络请求；换浏览器或清空站点数据后数据不跟随，需通过 JSON 备份迁移。
