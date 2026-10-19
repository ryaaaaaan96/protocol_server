# 部署与数据库迁移

## 环境与连接

先运行 `./scripts/check-env.sh`，检查工具、依赖、配置引用及 PostgreSQL 客户端。脚本不安装、不连接数据库、不打印密码；缺项返回退出码 1。捆绑服务工具不一定包含 `pg_dump` / `pg_restore`，可用 `PG_DUMP_BIN` / `PG_RESTORE_BIN` 指定兼容 PostgreSQL 18 的客户端。

| 参数 | 用途 |
| --- | --- |
| `DATABASE_URL` | `protocol_platform` 的运行角色连接，默认 `protocol_app` |
| `MIGRATION_DATABASE_URL` | 同一平台库的管理员连接，用于迁移、创建项目库和导出临时库 |
| `ADMIN_USERNAME` / `ADMIN_PASSWORD` | 平台账号为空时创建首个管理员，不重置已有账号 |
| `PROJECT_CONFIG_DIR` | 项目配置父目录，默认 `config` |
| `BIND_ADDR` | HTTP 地址，默认 `127.0.0.1:8080` |
| `COOKIE_SECURE` | HTTPS 环境设为 `true` |
| `STATIC_DIR` | 前端产物目录，默认 `frontend/dist` |

项目库连接复用平台连接的主机、端口和账号，仅替换数据库名；JSON 不保存密码。运行角色必须无 superuser、BYPASSRLS、CREATEDB、CREATEROLE，且不拥有表。迁移会给 `DATABASE_URL` 中的角色授予所需权限。迁移角色需要 CREATEDB、BYPASSRLS 及结构/安全函数所有权（或使用受信任超级用户）；管理员连接仅供受控建库和迁移使用，不执行网页上传的 SQL。

## 新环境启动

```bash
./scripts/init-db.sh
./scripts/create-project.sh dc-ups
./scripts/dev.sh
```

初始化只创建 `protocol_platform` 及账号、权限结构，不创建业务项目。创建命令读取 `config/dc-ups/`，建立 `protocol_project_dc_ups`，重复执行保留现有数据。DC-UPS 的来源工作簿仅导入 DSP 的 552 条内部点、445 条 UPP 转发；UPM 点表尚未启用。

本地 PostgreSQL 默认监听 `127.0.0.1:55432`，数据保存在 `.runtime/pgdata/`。重启电脑后运行 `node scripts/local-db.mjs start`，再运行 `./scripts/dev.sh`。停止数据库使用 `node scripts/local-db.mjs stop`；数据目录不能当缓存删除。

外部 PostgreSQL 先建立空平台库及运行角色，再配置两个 URL，运行 `cargo run -- migrate`。新版本迁移分别读取 `migrations/platform/`、`migrations/project/`；根目录旧迁移只用于旧单库拆分，不会自动套用到新平台库。

## 从旧单库 v15 拆分

旧库必须已完成 `0015_json_topology.sql`，业务 schema_version 为 3。更早版本先用匹配旧程序升级；新版本 `migrate` 会拒绝直接改造旧共享库。拆分必须停止旧 HTTP 服务并断开 DBeaver 等其他源库连接。

```bash
# .env 此时仍指向旧共享库；先停止旧 HTTP 服务
node scripts/split-databases.mjs --maintenance
```

脚本先生成完整 custom Dump 和恢复日志，默认位于 `.runtime/backups/split-<时间>/`；随后复制平台账号、权限与登记，并按项目建立业务库。原项目 `upm` 改为 `dc-ups`，显示名称为 DC-UPS，原项目 ID、点 ID、关联和历史保持不变。新增 UUID 绑定平台登记和业务库，旧预览清空，revision 增加以拒绝旧草稿；编辑租约保留原到期时间并补充操作者快照，到期自然释放。

脚本逐表比较完整记录摘要；已有目标库不属于当前迁移时直接拒绝，不覆盖。失败后保留备份和已创建目标，使用输出的日志路径续跑：

```bash
node scripts/split-databases.mjs --maintenance --journal .runtime/backups/split-<时间>/journal.json
```

成功后将 `.env` 中两个 URL 的数据库名都改成 `protocol_platform`，保留各自账号、密码与端口；配置使用 `config/dc-ups/`，不要同时保留旧 `config/upm/`。随后执行：

```bash
cargo run -- migrate
./scripts/dev.sh
```

脚本不自动改写 `.env` 或删除源库。确认切换后停止向旧源库写入，将其视为只供回退的副本。若回退，必须停新版服务，恢复旧连接、匹配的旧程序与配置；切换后产生的新修改不会自动回写旧库。完整备份不要与专用项目 Dump 混淆。

## 项目文件及配置更新

`config/<key>/project.json` 指定板卡目录、拓扑、名称和页签顺序。DC-UPS 的 key 是 `dc-ups`；UPM、DSP 等均为板卡类型。板卡目录分别包含 `process.json`、`collect.json`、`transmit.json`，显示规则实时读取，拓扑和点表归属配置须校验导入后生效。

在服务器或 SSH 中编辑 JSON，在网页重新读取、检查并导入。网页不提供拓扑编辑表单，点表仍可编辑。隐藏表格或调整本地列顺序不会删除数据。业务库 `project_state.topology_config` 保存生效快照，平台 `projects` 仅登记身份、名称及数据库位置。被点表或权限引用的板卡、分组、端点不能直接移除。

## 导出与导入项目文件夹

```bash
node scripts/export-project.mjs dc-ups
# 指定输出父目录：得到 /tmp/project-export/dc-ups/
node scripts/export-project.mjs dc-ups /tmp/project-export
```

默认输出 `.runtime/exports/<时间>/dc-ups/`，不覆盖已有目录。脚本从平台登记定位项目库并验证 UUID，需要 Node `pg`、管理员连接及 `pg_dump`；来源库只读。归档是含白名单数据的专用 custom Dump，只携带 `process_points`、`transmit_points`，要求 schema_version 4 且项目迁移版本匹配。

管理员在网页选择完整文件夹，预览后导入。预览不会创建项目数据库；提交相同 key 覆盖配置，新 key 才创建项目库。

- 带 Dump：替换该项目当前点表并追加历史，保留账号、成员、已有历史和发布。
- 不带 Dump：已有点表保持不变，新项目点表为空。文件夹内 XLSX 不触发自动导入。

普通全库 Dump 不能上传为项目归档。导入只解析 `pg_restore` 输出的白名单数据，不执行上传 SQL。每次最多 512 个文件、64 MiB，预览 30 分钟有效；版本、文件或编辑权变化时须重新预览。

每个配置父目录由单个服务实例管理。隐藏 `.imports/` 保存预览及恢复日志；崩溃后启动时核对业务提交记录、恢复目录并同步平台登记。不要删除尚未恢复的日志。新的项目创建需要服务器具备管理员建库连接，浏览器不会接触该凭据。

## 完整备份与跨机器迁移

停写后，分别备份平台库、**所有**项目库及匹配的 `config/`。使用管理员和 `.pgpass` 或受控的 `PGPASSWORD` 提供认证，不把密码写入命令历史或源码。例如当前只有 DC-UPS 时：

```bash
pg_dump -h DB_HOST -U postgres -d protocol_platform -Fc -f platform.dump
pg_dump -h DB_HOST -U postgres -d protocol_project_dc_ups -Fc -f dc-ups-full.dump
```

平台备份含密码散列和会话，按业务凭据保护。`.env`、角色密码和部署信息单独保管；数据库 Dump 不包含集群角色。专用 `project.dump` 不包含完整历史、权限和发布，不能替代上述备份。

目标实例建立运行角色及同名空库后，用管理员 `pg_restore --no-owner` 分别恢复。保留登记与 `project_state` 的相同 UUID，复制配置目录，配置新主机上的两个平台连接，再执行 `cargo run -- migrate`。检查登录、项目列表、点表数量、历史、工程师编辑、只读禁写及隔离后切换服务。需要强制重新登录时，清空平台库 `sessions`。

后续升级先备份，再运行新增迁移和新程序。已应用迁移不要修改校验和。迁移到 macOS 时使用该系统的 PostgreSQL 服务与客户端；当前 `local-db.mjs` 捆绑实例仅支持 Linux x64。

## 可选容器部署

Compose 默认平台库为 `protocol_platform`，初始化后不自动创建项目。运行服务需要管理员连接以创建项目库，同时使用独立非超级用户处理日常业务。已有旧卷先按拆分步骤迁移，不能仅更改 `POSTGRES_DB` 就完成升级。容器构建、配置目录持久化权限以及归档客户端须在目标环境验证；目前不把 Docker 运行验证视为本地测试的一部分。
