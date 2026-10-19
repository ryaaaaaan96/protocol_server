# Protocol Studio · 协议管理平台

使用 Rust、Vue 3、TypeScript 和 PostgreSQL 管理点表。当前实现 **DC-UPS 项目的 DSP 内部数据及 UPP 转发表**；UPM、CSU、IDU 仅显示 JSON 定义的拓扑，点表暂未启用。

## 启动与升级

首次部署：

```bash
./scripts/check-env.sh               # 检查缺少的工具、依赖和配置，不安装、不连接数据库
./scripts/init-db.sh                 # 初始化 PostgreSQL 18、账号和表结构，不创建项目
./scripts/create-project.sh upm      # 从 config/upm/ 创建 DC-UPS，重复执行保留已有数据
./scripts/dev.sh                     # 构建前后端并启动 HTTP 服务
```

打开 http://127.0.0.1:8080，使用 `.env` 的 `ADMIN_USERNAME` / `ADMIN_PASSWORD` 登录。没有固定默认密码。数据库与 HTTP 服务独立启动；电脑重启后运行：

```bash
node scripts/local-db.mjs start
./scripts/dev.sh
```

更新代码涉及数据库迁移时，先停止旧 HTTP 服务、备份数据库，然后执行 `cargo run -- migrate`，再运行 `./scripts/dev.sh`。**0015 会删除旧关系表**，升级条件及回退方法见 [部署与数据库迁移](docs/operations.md)。不要删除或修改已经应用的迁移文件。

本地 PostgreSQL 默认端口为 `55432`，真实持久数据在 `.runtime/pgdata/`。停止数据库使用 `node scripts/local-db.mjs stop`。`dev.sh` 不自动启动数据库、迁移或创建项目。

## 项目文件与数据库

**一个 `config/` 子目录就是一个项目。** DC-UPS 保留稳定标识 `upm`，避免改名后产生另一项目：

```text
config/upm/
  project.json                 key、显示名称、板卡类型、挂载关系、目录和页签顺序
  DSP/
    process.json               DSP 内部数据的列、字段及编辑规则
    collect.json               暂未启用
    transmit.json              DSP UPP 转发表的列、字段及编辑规则
  CSU/ UPM/ IDU_T/ IDU_R/       其他板卡定义，点表暂未启用
  sources/                     可选的首次创建来源工作簿
  project.dump                 可选的专用单项目归档
```

板卡名和 `directory` 在 `project.json.topology.board_types` 指定，不需要额外的 `point-tables/` 层。`point_groups` 定义 LOCAL 等分组；`point_endpoints` 定义 UPP 端点。

JSON 是组织配置的编辑来源。服务器文件修改后，通过网页读取、检查并导入；网页不提供拓扑编辑表单。表格展示定义刷新即可读取；拓扑导入后才更新数据库中的生效快照，以保证已有点和授权仍有归属。

数据库只保存两张当前业务表：`process_points` 和 `transmit_points`，另有 `point_history` 保存修改历史。全部 public 表为 **16 张**：其余用于项目身份/生效快照、账号、权限、编辑锁、审计、预览和发布。已移除 `board_models`、`signal_groups`、`data_items` 等 17 张旧表和 9 个视图。具体字段见 [数据库结构](docs/architecture.md)。

## DSP 点表

默认工作簿仅导入两张 sheet：

| 来源 | 用途 |
| --- | --- |
| DSP内部数据 | 552 条内部点：名称、枚举、类型、元素数量、单位、范围、恢复策略 |
| UPM-DSP采集数据 | 445 条 DSP UPP 转发：内部点引用、模型、显式字节偏移、通信类型、比例与转换 |

同一个内部点可对应多条转发，通过固定 `process_point_id` 关联。DSP sigID 未在来源确认，保留为空；不使用 UPM 采集端编号代替。本次不创建 UPM 采集点。

网页支持设置弹窗、逐格编辑、复制粘贴、批量添加和撤销草稿。先「开始编辑」，校验通过后确认整批提交；提交失败保留草稿。成功提交释放编辑权。无关字段修改可合并，同字段、引用或顺序冲突会拒绝提交。

首列拖动只调整显示顺序，不重算 UPP 地址；列隐藏、冻结、顺序和分页设置只保存在当前浏览器。范围字段直接在内部数据表维护。校验包括类型/长度、范围、枚举、sigID、UPP 地址重叠和关联归属。

当前生成 DSP JSON/XML 及项目快照，可冻结发布并下载 ZIP。发布不可修改；生成文件尚不等同于 DSP 固件编译验收。

## 配置与迁移项目

每个板卡目录包含 `process.json`、`collect.json`、`transmit.json`。字段包括 `version: 1`、`enabled`、`label`、`description`、`columns`、`editor`、`ordering`、`inline`、`fields`。隐藏表格不会删除数据或改变权限；新增存储字段仍需后端实现。项目文件中转发表标识为 `transmit`，API 使用 `forward`。

导出可移植项目文件夹：

```bash
node scripts/export-project.mjs upm
```

默认输出 `.runtime/exports/<时间>/upm/`，包含配置及专用 `project.dump`。在网页「项目设置 → 导入项目文件夹」选择完整目录：相同 key 覆盖配置，新 key 建立项目。

- 带 Dump：替换该项目当前点表，追加修改历史，保留账号、授权、原历史和发布。
- 不带 Dump：保留当前点表；新项目点表为空。文件夹中的 XLSX 不会自动导入。

CLI 创建优先使用 Dump，否则只支持 `workbook_boards: ["DSP"]` 的 DSP 来源导入。项目 Dump 不携带历史、账号和发布，完整迁移使用全库备份。新版本只接受 schema_version 3 且迁移版本匹配的专用归档；旧归档需在匹配旧环境中处理后重新导出。

逐表 Excel 追加示例见 [批量添加](docs/batch-add.md)。

## 开发与验证

```bash
npm ci --prefix frontend
npm run dev --prefix frontend        # Vite，代理到后端 8080
npm run build --prefix frontend
cargo fmt --check
cargo test
node tests/point-grid.mjs
node tests/point-grid-selection.mjs
node frontend/native-points-check.mjs
node frontend/browser-check.mjs
node --test scripts/excel-batch/workbook.test.mjs
node tests/integration.mjs
node tests/migration.mjs
```

集成与迁移检查创建并清理独立临时数据库，支持 `TEST_MIGRATION_DATABASE_URL` / `TEST_DATABASE_URL`，未提供时读取 `.env`。需要本地 `pg`、运行角色及匹配的 `pg_dump` / `pg_restore`。浏览器测试需要 Playwright Chromium 和系统库。`node tests/local-db.mjs` 验证本地数据库工具，不操作现有业务库。

后端在 `src/`，前端在 `frontend/src/`，迁移在 `migrations/`，运维脚本在 `scripts/`。外部 PostgreSQL 建议使用 18；迁移管理员与 `protocol_app` 运行角色必须分开，运行角色不得拥有超级用户或 `BYPASSRLS` 权限。部署参数、完整备份及 Docker 说明见 [运维文档](docs/operations.md)。
