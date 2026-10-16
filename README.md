# Protocol Studio · 协议管理平台

使用 **Rust + Vue 3 + TypeScript + PostgreSQL** 管理工业协议点表。维护源数据，通过 SQL 视图计算地址和映射，再生成 AIDC 工程配置。代码、数据迁移和测试均在当前目录。

## 启动

当前机器已初始化开发数据库。旧版 612 条主测点迁移为板卡、内部信号、协议字段和绑定关系，保留旧记录作为迁移档案。

```bash
./scripts/dev.sh
```

打开 http://127.0.0.1:8080 。登录账号和密码对应根目录 `.env` 的 `ADMIN_USERNAME`、`ADMIN_PASSWORD`；首次初始化使用随机密码，没有固定默认口令。`.env` 权限为 `600`，已加入忽略规则。

这个脚本适用于 **Linux x64**：在 `.runtime/` 内启动真正的 PostgreSQL 18，使用端口 `55432`，无需安装系统服务。首次运行会下载依赖；后续保留数据。HTTP 服务由 `Ctrl+C` 停止，数据库单独停止：

```bash
node scripts/local-db.mjs stop
```

启动脚本通过 `pg_ctl status` 检查实际进程状态，并等待数据库连接就绪；异常停止后遗留的 `postmaster.pid` 由 PostgreSQL 在启动时处理。启动失败时查看 `.runtime/postgres.log`，不需要删除现有数据库目录。

在另一台机器启动后，登录界面创建项目并导入 Excel；也可以在服务运行时执行：

```bash
python3 scripts/seed-workbook.py
```

该脚本只向新建或空的「UPM 协议配置」项目导入，已有数据时不会覆盖。

## 功能

- 项目下管理板卡模板与多个板卡实例，配置端点、协议连接、通信地址和设备编码。
- 板卡内用 `(dev_id, sigID)` 关联采集、处理、普通转发和 range；板卡之间使用共享协议契约连接，两端 sigID 独立。
- 共享数据定义、内部类型覆盖、协议类型覆盖、信号范围与恢复策略分别维护。
- 编辑必须先查看关联影响，再提交：显示受影响板卡、信号、协议字段及地址变化。引用删除、冲突、跨项目引用和过期预览会被阻止。
- SQL 自动计算 UPP 模型偏移、Modbus 寄存器地址和透传窗口展开；保留手动地址锚点。
- Excel 预览与原子导入，覆盖已有配置必须明确确认；可查看源单元格与公式。
- 只读 SQL 工作台，限定当前项目、函数/表白名单、3 秒超时、最多 500 行。
- JSON 项目按板卡类型生成协议 JSON/XML，包含项目组成文件；选择 AIDC 目标的模板额外生成采集、处理、转发、range、设备注册等 C 配置。
- 冻结版本、ZIP 下载、源数据快照和审计；后续编辑不改变已发布文件。
- 平台管理员、按项目分配的工程师和只读用户，使用 PostgreSQL RLS 隔离数据。

前端使用 Vue 3 Composition API、TypeScript 和 Vite。「项目拓扑」与「板卡内部信息」是同级页面。拓扑页仅显示 **CSU、UPM、DSP、变压器 IDU、整流模块 IDU 五类板卡**、挂载数量和通信关系，点击任一板卡节点，直接进入该板卡的内部信息；节点也支持 Enter / 空格键操作。点表统一放在「板卡内部信息」，按板卡类型切换；每类只维护一份配置，包括采集、转发、range、协议字段、板间协议及逻辑设备。表头和名称列固定，支持搜索和分页，字号与行距按表格操作调整。

「项目设置」维护共享模板、协议、数据目录和工作簿来源。修改共享数据时，预览列出受影响板卡类型及挂载数量。编辑关联项随类型、端点和逻辑设备联动；校验问题直接跳转到所属板卡的内部信息页。

## 项目 JSON 配置

[config/project.example.json](config/project.example.json) 定义五种板卡及四条挂载关系：每个 CSU 挂载 24 个 UPM、1 个变压器 IDU、4 个整流模块 IDU；每个 UPM 挂载 8 个 DSP。拓扑按父子关系自动分支，每类只显示一个节点，数量不复制点表或展开成数百个节点。CSU ↔ UPM 同时配置 Modbus / CAN FD 与 UPP / CAN FD；UPM ↔ DSP 为 UPP / CAN；CSU 与两类 IDU 均为 Modbus RTU / RS485。变压器 IDU（`IDU_T`，模板 `IDU_TRANSFORMER`）和整流模块 IDU（`IDU_R`，模板 `IDU_RECTIFIER`）分别维护独立点表；新增模板为空，具体寄存器、地址与内部信号需按实际点表配置。

在「项目设置」或「板卡内部信息 → 板间协议」点击「项目 JSON 配置」可导入、编辑、导出文件；检查后应用，更新遵循项目权限、revision 锁和审计。`board_types[].model_code` 按项目内模板代码关联现有点表；首次出现的类型建立空模板。`root` 指定根类型及数量，`mounts[].quantity` 是**每个上级**的挂载数。JSON `version: 2` 使用 `mounts[].connections` 数组保存多组 `{protocol, transport}`，`CANFD` 与 `CAN` 分别表示 CAN FD 和经典 CAN，空数组表示协议待配置；添加协议不会重复计算板卡数量。兼容导入旧版 `version: 1` 的单组 `protocol/transport`（同时为 `null` 表示待配置），应用时转为新版。循环、重复上级、非法数量、与已有端点冲突的协议会被拒绝。

新建项目使用此 JSON 作为可编辑模板；修改磁盘示例文件影响新建项目的默认值，已有项目通过导入和预览应用修改。项目配置保存到 PostgreSQL 的 `projects.topology_config`，点表和权限仍使用关系表。工作簿替换导入保留项目组成，JSON 导出及版本快照包含该配置。

## 工作簿导入范围

| 工作表 | 建模用途 |
| --- | --- |
| DSP内部数据 | 552 条 DSP 源定义；按上传级别筛选出 445 个协议字段 |
| UPM-DSP手动配置数据 | ARM 代理 sigID、标志、轮询、优先级与回调 |
| UPM-DSP采集数据 | 作为投影来源保留；有前两张源表时从源数据重建，不依赖派生缓存 |
| UPM单板测点 | 167 条本地条目；同一信号的多个地址拆成多个协议字段 |
| 平台公共测点映射表 | 公共符号解析 |
| UPM板内Modbus地址分配 | UPM 与 8 个 DSP 实例的地址窗口 |
| CSU、BMS、侦测板相关源表 | 保留原始行，标记待映射 |

工作簿提供 UPM 与 DSP 的点表，以及 UPM 内部面向 8 个 DSP 的采集上下文、UPP 连接和 Modbus→UPP 透传窗口；它们属于 UPM 板内配置，不作为首页的 8 个独立板卡模块。项目整体组成由 JSON 定义。DSP 固件的内部数字 sigID 未在源表中明确，因此不沿用 ARM 的 sigID 推断。

CSU 已有独立类型入口，源工作表尚未映射为 CSU 内部点表；CSU ↔ UPM 已声明两种 CAN FD 协议；原始工作簿中的 UPM 端点仍按来源保留，实际端口与两端协议字段需单独配置。BMS、侦测板的真实端口和连接未明确；HMI 大型派生表未接入。源表中已有的类型/长度、上下限等问题保留在校验中心，阻断错误清理后才能发布。平台没有自动改写原工作簿或 AIDC 参考工程，也未接入钉钉 API。

## 连接已有 PostgreSQL

要求 PostgreSQL **15 或更高版本**（使用 `security_invoker` 视图）。建议部署 PostgreSQL 18。

1. 复制 `.env.example` 到 `.env`，设置数据库地址与随机密码。已有 `.env` 时先保留自己的配置。
2. 使用数据库管理员创建专用账号：

   ```sql
   CREATE DATABASE protocol_studio;
   CREATE ROLE protocol_app LOGIN PASSWORD '替换为随机密码'
     NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
   ```

3. `DATABASE_URL` 使用 `protocol_app`，`MIGRATION_DATABASE_URL` 使用迁移管理员。
4. 运行：

   ```bash
   npm ci --prefix frontend
   npm run build --prefix frontend
   cargo run -- migrate
   cargo run
   ```

迁移会给 `protocol_app` 授予所需权限。迁移账号与运行账号应分开；服务会拒绝超级用户或具有 `BYPASSRLS` 的运行账号。普通运行不会自动迁移数据库。

本地调试前端时另开终端执行 `npm run dev --prefix frontend`，Vite 将 `/api` 代理到 Rust 的 `8080` 端口。

## Docker Compose

已提供 Dockerfile 和 Compose 配置，当前环境没有 Docker，容器构建尚未实测。

在 `.env` 设置 `POSTGRES_PASSWORD`、`POSTGRES_APP_PASSWORD`、`ADMIN_PASSWORD`（建议十六进制随机值，避免数据库 URL 转义问题），然后：

```bash
docker compose up --build -d
```

依次运行数据库初始化、迁移和应用。默认只监听本机 `8080`。如需内网访问，设置 `HTTP_BIND=0.0.0.0`。启用 HTTPS 反向代理后设置 `COOKIE_SECURE=true`。

## 测试

```bash
cargo test
npm run build --prefix frontend
cargo build
node tests/local-db.mjs
node tests/integration.mjs
node tests/migration.mjs
python3 tests/compile-generated.py
```

`tests/local-db.mjs` 使用临时 PostgreSQL 集群，验证残留 PID 文件后的恢复、重复启动/停止、连接等待及原数据保留，不操作已有业务数据库。

集成测试读取 `.env` 连接开发 PostgreSQL，创建独立临时数据库和临时 HTTP 服务，测试结束删除临时数据库，不覆盖已有业务项目。它依赖 `scripts/local-db.mjs` 安装的本地 `pg` 客户端。覆盖数据库行级权限、API 权限、SQL 隔离、乐观锁、导入事务、生成和版本不可变性。

C 合约测试编译生成文件并验证设备注册、独立 sigID、别名、地址移动、浮点类型、范围查询及独立恢复策略；使用与参考接口一致的最小类型声明。**这不等于完整固件编译或硬件联调**。参考工程当前缺少独立编译所需的部分驱动头文件，生成代码上线前仍需目标工程验证。

浏览器检查：

```bash
cd frontend
npx playwright install chromium
node browser-check.mjs
```

需要应用已经启动，已导入上述 UPM 项目并应用示例 JSON，以及 Chromium 所需系统库和中文字体。检查覆盖拓扑与板卡信息的页面拆分、跳转及板卡切换、五个类型节点、分支布局、同一关系的双 CAN FD 协议及旧版 JSON 兼容、24/8/1/4 挂载数量及两类 IDU 的独立配置、采集和转发归属、引用联动、range 继承值、共享修改影响、JSON 导入导出与预览、只读界面及手机布局；也检查来源单元格、SQL 和发布阻断。仅预览配置，不提交业务修改。通过 BASE_URL 可指定服务地址，截图保存在 `.runtime/`。

## 目录

```text
src/                       Rust：认证、API、导入、校验、生成、SQL 防护
migrations/                PostgreSQL 表结构、RLS 策略、SQL 视图和授权
frontend/src/App.vue       Vue 应用和工作空间状态
frontend/src/pages/        各业务页面
frontend/src/components/   通用组件与编辑/导入弹窗
config/                    项目 JSON 示例：板卡类型与协议挂载关系
scripts/                   启动、数据库初始化和工作簿导入
tests/                    隔离数据库集成测试与 C 合约测试
docs/                     数据模型与规则说明
```

## 参考

- 本地 `AIDC_CODE/CODE/app/cfg/equip` 的设备、采集、处理、转发、范围表结构及 sig_id 分配约定。
- [codegenerationV2](https://github.com/ryaaaaaan96/codegenerationV2)，参考提交 `2290967aaf2570756abafef4bee6890e72aed4b2` 的字段、文件命名、XML 结构和自动采集 ID 规则。
- [PostgreSQL 行级权限](https://www.postgresql.org/docs/18/ddl-rowsecurity.html)：用于项目级数据访问隔离。

详细规则见 [docs/architecture.md](docs/architecture.md)，备份迁移见 [docs/operations.md](docs/operations.md)。
