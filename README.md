# Protocol Studio · 协议管理平台

使用 Rust、Vue 3、TypeScript 和 PostgreSQL 管理点表。当前支持 **DSP 内部数据与 UPP 转发表，以及 UPM 的 LOCAL/DSP 内部点、UPP 采集和 Modbus/UPP 对外表**。CSU、IDU 暂仅显示拓扑。

## 启动与升级

首次部署：

```bash
./scripts/check-env.sh               # 检查缺少的工具、依赖和配置，不安装、不连接数据库
./scripts/init-db.sh                 # 初始化 PostgreSQL 18、账号和表结构，不创建项目
./scripts/create-project.sh dc-ups   # 从 config/dc-ups/ 创建 DC-UPS，重复执行保留已有数据
./scripts/dev.sh                     # 构建前后端并启动 HTTP 服务
```

打开 http://127.0.0.1:8080，使用 `.env` 的 `ADMIN_USERNAME` / `ADMIN_PASSWORD` 登录。没有固定默认密码。数据库与 HTTP 服务独立启动；电脑重启后运行：

```bash
node scripts/local-db.mjs start
./scripts/dev.sh
```

更新代码涉及数据库迁移时，先停止旧 HTTP 服务、备份数据库，然后执行 `cargo run -- migrate`，再运行 `./scripts/dev.sh`。**旧单库 v15 必须先执行分库迁移，不能直接运行新版本的 migrate**，操作及回退方法见 [部署与数据库迁移](docs/operations.md)。不要删除或修改已经应用的迁移文件。

本地 PostgreSQL 默认端口为 `55432`，真实持久数据在 `.runtime/pgdata/`。停止数据库使用 `node scripts/local-db.mjs stop`。`dev.sh` 不自动启动数据库、迁移或创建项目。

## 项目文件与数据库

**一个 `config/` 子目录就是一个项目。** DC-UPS 的项目标识为 `dc-ups`，UPM 只是其中一种板卡：

```text
config/dc-ups/
  project.json                 key、显示名称、板卡类型、挂载关系、目录和页签顺序
  DSP/
    process.json               DSP 内部数据的列、字段及编辑规则
    collect.json               暂未启用
    transmit.json              DSP UPP 转发表的列、字段及编辑规则
    transmit.js                UPP 协议字节数及偏移地址计算
  UPM/                         内部点、DSP UPP 采集、Modbus/UPP 对外表
  CSU/ IDU_T/ IDU_R/            其他板卡定义，点表暂未启用
  sources/                     可选的首次创建来源工作簿
  project.dump                 可选的专用单项目归档
```

板卡名和 `directory` 在 `project.json.topology.board_types` 指定，不需要额外的 `point-tables/` 层。`point_groups` 定义 LOCAL 等分组；`point_endpoints` 定义协议与采集/转发方向；UPM 分组的 `devices` 定义共享模板的设备实例。

JSON 是组织配置的编辑来源。服务器文件修改后，通过网页读取、检查并导入；网页不提供拓扑编辑表单。表格展示定义刷新即可读取；拓扑导入后才更新数据库中的生效快照，以保证已有点和授权仍有归属。

数据库采用 **一个平台库 + 每项目一个业务库**，共用一个 PostgreSQL 实例：

- `protocol_platform`：账号、登录会话、项目登记、成员权限及平台审计，按 Schema 分组，共 8 张表。
- `protocol_project_dc_ups`：DC-UPS 的点表、历史、配置快照和发布，按 Schema 分组，共 8 张表。

平台库：

| 分组 | 表 | 用途 |
| --- | --- | --- |
| `auth` | `users`、`sessions`、`login_attempts` | 账号、登录会话及尝试限流 |
| `meta` | `projects`、`project_members`、`project_member_grants` | 项目定位、成员及编辑范围 |
| `history` | `audit_logs` | 平台账号和权限操作审计 |
| `public` | `_sqlx_migrations` | 平台结构升级记录 |

每个项目库：

| 分组 | 表 | 用途 |
| --- | --- | --- |
| `points` | `process_points`、`collect_points`、`transmit_points` | 当前内部点、采集和转发映射 |
| `history` | `events`、`releases` | 统一修改/审计/导入事件，以及不可变发布 |
| `meta` | `project_state`、`previews` | 项目版本、生效配置和编辑权，以及待确认修改/导入 |
| `public` | `_sqlx_migrations` | 数据库结构升级记录，必须保留 |

新项目按 `protocol_project_<key>` 建库，短横线转为下划线。板卡不单独建库；业务库中没有账号或成员权限表。具体字段见 [数据库结构](docs/architecture.md)。

## UPM 点表

UPM 使用 LOCAL 本地设备和 DSP 共享模板，8 个 DSP 设备地址独立配置。LOCAL 无采集表；DSP 使用 UPP 采集；对外分为 Modbus 和 UPP 两个视图。详见 [UPM 数据来源与地址规则](docs/upm.md)。

`upm-demo` 演示设备仅显示一张采集表，用 `collect.js` 将 UPM Modbus 对外定义按 LOCAL、DSP1～DSP8 完整展开为 3646 条实际地址。派生表只读，源数据及 JSON/JS 修改会实时反映，无需复制点数据或数据库迁移。详见 [upm-demo 配置](docs/upm-demo.md)。

已有 DC-UPS 项目首次启用 UPM：

```bash
cargo run -- migrate
cargo run -- import-upm dc-ups
./scripts/dev.sh
```

重复运行 `import-upm` 保留已有 UPM 点表。网页重新导入 Excel 时选择对应板卡并预览确认。

## DSP 点表

DSP 范围读取两张 sheet：

| 来源 | 用途 |
| --- | --- |
| DSP内部数据 | 552 条内部点，保留原 sheet 的 25 个来源字段；界面隐藏通信类型和型号，显示 23 列 |
| UPM-DSP采集数据 | 445 条 DSP UPP 转发：内部点引用、模型、显式字节偏移、通信类型、比例与转换 |

DSP 内部数据没有 sigID，以原 sheet 的变量名、类型及参数为定义。网页保留 `VariateName` 的原始大小写、`DateType` 的 `Sys_` 前缀及原列顺序；`EnumTab` 是枚举说明，与变量名分开。原 A1 标题为空，界面标为「数据名称」。长度和精度为只读派生列；“数据类型”和“UPP 模型号”在内部表隐藏。

数据类型仅在转发表编辑：数组建议 `STRING`；标量去掉 `Sys_` 前缀，其中 `F32` 建议 `S32`。新增转发自动提供类型、长度和比例的建议；偏离建议会提示，仍须通过转换校验。已有通信类型和比例保留，需主动应用建议才会替换；协议字节数由整表规则计算。数据转换自动确定：同类型直接映射，`F32 → S32` 按协议系数缩放，数组到 `STRING` 按字节映射。DSP 不提供“数据转换”和“字节序”配置入口；UPM 接收端独立配置字节序。

转发表按数据分类筛选，型号在后台固定推导：系统参数1→1、系统参数2→2、任务级观测量→99、中断级观测量→100、控制参数设置→102、任务级标定量→103。修改内部分类会同步所有关联转发，检查权限和目标分类的地址冲突后原子保存；规则重算受影响的偏移，预览后确认。

转发表的“数据名称”和 `VariateName` 直接引用内部点；数据分类后显示只读“UPP模型号”。“UPP偏移地址”和“UPP协议字节数”显示规则计算后保存的实际通信布局。取消独立转发名称及启用开关，所有存在的 DSP 映射参与协议生成和地址冲突校验，不需要时删除映射，历史仍保留。

同一个内部点可对应多条转发，通过固定 `process_point_id` 关联。修改变量名不改变引用；系统 ID、来源和兼容字段保留在后台。每块板卡的显示及通讯规则独立配置；采集端点可用 JSON `subset_of` 声明源转发子集。UPM 已声明 DSP 来源，源协议参数修改会同步已选采集项，接收周期、优先级和字节序独立维护，见 [UPM 点表](docs/upm.md)。

网页支持设置弹窗、逐格编辑、复制粘贴、批量添加和撤销草稿。先「开始编辑」，校验通过后确认整批提交；提交失败保留草稿。成功提交释放编辑权。无关字段修改可合并，同字段、引用或顺序冲突会拒绝提交。

DSP 新增「总体视图」：按内部点关联转发参数，无转发的内部点仍显示，一对多映射分别占行。双击单元格编辑，Tab 切换、Enter 移到下一行；重复出现的内部字段共享草稿，转发参数各自独立。点「检查并保存」预览两张表及规则重算的全部影响，确认后在同一事务保存并记录历史。末列固定提供内部/转发设置及添加转发入口；支持搜索、转发状态筛选、撤销/重做和本地列设置。计算列保持只读，总表没有独立的数据副本。

首列拖动只调整显示顺序，不重算 UPP 地址；列隐藏、冻结、顺序和分页设置只保存在当前浏览器。列定义改变时采用新默认布局。范围字段直接在内部数据表维护。校验包括类型/长度、范围、变量名、sheet 参数选项、UPP 地址重叠和关联归属。

当前生成 DSP JSON/XML、UPM 点表与设备转发地址 JSON 及项目快照，可冻结发布并下载 ZIP。发布不可修改；生成文件尚不等同于 DSP 固件编译验收。

## 配置与迁移项目

每个板卡目录包含 `process.json`、`collect.json`、`transmit.json`。字段包括 `version: 1`、`enabled`、`label`、`description`、`columns`、`editor`、`ordering`、`inline`、`fields`，转发表可增加 `calculation`。隐藏表格不会删除数据或改变权限；新增存储字段仍需后端实现。项目文件中转发表标识为 `transmit`，API 使用 `forward`。

导出可移植项目文件夹：

```bash
node scripts/export-project.mjs dc-ups
```

默认输出 `.runtime/exports/<时间>/dc-ups/`，包含配置及专用 `project.dump`。在网页「项目设置 → 导入项目文件夹」选择完整目录：相同 key 覆盖配置，新 key 建立项目。

- 带 Dump：替换该项目当前点表，追加修改历史，保留账号、授权、原历史和发布。
- 不带 Dump：保留当前点表；新项目点表为空。文件夹中的 XLSX 不会自动导入。

CLI 创建优先使用 Dump，否则按 `workbook_boards: ["DSP", "UPM"]` 定向导入配置的板卡。项目 Dump 不携带历史、账号和发布，完整迁移分别备份平台库、全部项目库和配置目录。新导出的专用归档使用 `(schema_version, migration_version) = (6, 3)`，同时兼容旧 `(4, 1)`、`(5, 2)` 两表归档；只导入白名单中的三张点表，其他版本拒绝导入。

已有独立项目库升级到分组结构时，迁移完整保留当前点、历史和发布，合并编辑权及预览存储。旧修改/导入预览失效，迁移 0002 将版本更新为 5，迁移 0003 增加采集表并更新为 6，每次结构升级各增加一次 `revision`；升级后刷新网页并重新预览尚未提交的修改。

平台迁移 `migrations/platform/0002_grouped_platform.sql` 将原 `public` 表移入上述分组，仍保留 8 张表及原记录、约束和登录会话。它只更新平台迁移记录，不改变项目的 `schema_version` 或 `revision`。先完整备份，再运行 `cargo run -- migrate` 并重启服务；DBeaver 刷新后展开新 Schema，自有 SQL 改用 `auth.users`、`meta.projects` 等限定名。

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
cargo build                        # 更新接口测试使用的后端可执行文件
node tests/integration.mjs
node tests/migration.mjs
```

集成与迁移检查创建并清理独立临时数据库，支持 `TEST_MIGRATION_DATABASE_URL` / `TEST_DATABASE_URL`，未提供时读取 `.env`。需要本地 `pg`、运行角色及匹配的 `pg_dump` / `pg_restore`。浏览器测试需要 Playwright Chromium 和系统库。`node tests/local-db.mjs` 验证本地数据库工具，不操作现有业务库。

后端在 `src/`，前端在 `frontend/src/`，迁移在 `migrations/`，运维脚本在 `scripts/`。外部 PostgreSQL 建议使用 18；迁移管理员与 `protocol_app` 运行角色必须分开，运行角色不得拥有超级用户或 `BYPASSRLS` 权限。部署参数、完整备份及 Docker 说明见 [运维文档](docs/operations.md)。

### DSP 协议计算规则

`config/dc-ups/DSP/transmit.json` 使用 `calculation.engine: "builtin"`，Rust 根据 JSON 的类型字节数、分组、排序和固定偏移计算整表。默认规则复现 Excel 的 445 条转发：按模型、上传等级和稳定来源顺序排列，普通偏移从 6 累加，六个名称保留固定地址。界面拖动仅改显示顺序。

修改内部长度、分类、上传等级或转发引用后，保存预览会包含全部联动结果。修改 JSON 参数后，在转发表点击“重算协议布局”，预览并保存；读取配置不会改写数据库。布局与当前规则不一致时阻止生成和发布。日后调整计算参数无需数据库迁移；本次通用化重构需先执行项目迁移 0004。UPM 地址目前独立保留源表结果。脚本接口、TS 编写方式及执行限制见 [点表计算](docs/table-calculation.md)。

新增板卡、工作簿列映射和协议参数的配置方法见 [JSON 板卡配置](docs/board-configuration.md)。复用现有字段和协议时无需新增 Rust 模块或数据库表。
