# 部署与数据库迁移

## 迁移环境检查

在旧机器和目标机器分别运行 `./scripts/check-env.sh`，需要时将输出保存为报告比较。它检查工具、配置引用、前端依赖、浏览器及动态库，并分别检查 `pg_dump` / `pg_restore`；捆绑的 `pg_ctl` 可用不代表包含这两个客户端。它不安装、不启动服务、不连接数据库、不打印密码；缺项返回退出码 1。

浏览器库缺失时可按提示执行 `cd frontend && npx playwright install-deps chromium`；浏览器也缺失时执行 `npx playwright install --with-deps chromium`。系统库安装需要相应权限。检查通过后仍需验证实际构建、数据库恢复和浏览器测试；数据库内容不会随 Git 或 `config/` 自动迁移。

## 配置职责

| 参数 | 用途 |
| --- | --- |
| DATABASE_URL | HTTP 服务使用的 protocol_app 非超级用户连接 |
| MIGRATION_DATABASE_URL | 迁移及项目导出使用的管理员连接；导出需创建并清理临时数据库 |
| ADMIN_USERNAME / ADMIN_PASSWORD | 数据库为空时创建首个管理员，后续不会重置现有账号 |
| BIND_ADDR | Rust 监听地址，默认 127.0.0.1:8080 |
| COOKIE_SECURE | HTTPS 环境设为 true |
| STATIC_DIR | 生产前端目录，默认 frontend/dist |
| PROJECT_CONFIG_DIR | 项目配置的父目录，默认 config；每个项目自带 project.json、清单指定的板卡目录及可选来源文件 |
| PG_DUMP_BIN / PG_RESTORE_BIN | 可选的 PostgreSQL 客户端绝对路径，未设置时从 PATH 查找 |

不要把迁移管理员连接作为运行连接。本版迁移给名称为 `protocol_app` 的角色授权；如采用其他角色名，需在部署时单独授予等价权限并测试 RLS。

## 本地数据库与项目分开创建

首次运行 `./scripts/init-db.sh` 明确创建本地数据库、应用角色和表结构，不创建业务项目。随后由管理员在服务器终端或 SSH 会话中运行 `./scripts/create-project.sh upm`，从 `config/upm/project.json` 创建项目，最后运行 `./scripts/dev.sh` 启动应用。已经初始化的数据库可用 `node scripts/local-db.mjs start` / `stop` 单独控制；启动应用和数据库不会自动初始化新库。

外部 PostgreSQL 创建空库和运行角色后，执行 `cargo run -- migrate` 安装表结构，再运行项目创建脚本或在网页导入项目文件夹。运行角色不得拥有表或绕过 RLS。CLI 创建优先导入项目 Dump；没有 Dump 时使用可选 workbook，均未提供则创建空点表。创建脚本重复运行会保留已有项目；已有项目的覆盖更新通过文件夹预览和导入完成。

本地模式的 `.runtime/pgdata/` 保存完整业务数据库，不能当缓存删除。`config/<项目名>/` 中的 JSON 保存项目定义，点表行、用户和权限保存在 PostgreSQL。单项目可通过下面的项目 Dump 迁移；完整工作空间恢复使用全库备份，恢复目标须为空库。

## 0015 精简升级

本版迁移 `0015_json_topology.sql` 删除 17 张旧关系表及 9 个视图，最终保留 16 张表。当前业务数据仅为 `process_points` / `transmit_points`；`point_history` 保存修改前后记录。板卡、分组和端点改为 JSON 代码，不再依赖 SQL 模板 ID。

升级顺序：停止旧 HTTP 服务 → 全库备份并保存匹配配置目录 → 迁移 → 部署新前后端。

```bash
node scripts/local-db.mjs start
# 先按后文完成全库备份
cargo run -- migrate
./scripts/dev.sh
```

迁移保留 DSP 点和历史的原 ID，也保留账号、成员、锁、审计和发布。旧授权转为板卡/端点代码，同一协议对应多个端点时展开授权；旧预览失效，项目 revision 增加 1，业务 schema_version 升至 3。

若旧 `data_items`、`signals`、绑定、实例等仍有数据，或旧组织配置不能安全转成 JSON，迁移会报错并整体回滚。需在旧版本中整理/迁移这些项目后再升级；不要手工删表绕过保护。该迁移不实现 UPM 点表转换。回退需恢复完整备份及匹配旧程序，不能仅回滚 Git 后继续使用精简后的数据库。

新环境依次执行 `init-db.sh`、`create-project.sh upm`、`dev.sh`。DC-UPS 的 `workbook_boards: ["DSP"]` 仅导入 552 条内部点和 445 条 UPP 转发；UPM 侧采集尚未实现。未知 DSP sigID 保持空值。生成 JSON/XML 不替代固件编译验证。

验收时检查两表数量、ID 与历史、分组/端点归属、编辑保存、批量、显示排序、权限和项目 Dump 往返。`node tests/migration.mjs` 在临时库检查保留数据、授权转换、失败回滚及重复迁移，不操作业务项目。

## 板卡点表配置部署

每个项目都使用独立的 `config/<项目标识>/` 目录。DC-UPS 项目的稳定标识为 `upm`，配置位于 `config/upm/`。`project.json` 的 `topology.board_types[].directory` 指向该项目内的板卡目录；当前项目直接包含 CSU、UPM、DSP、IDU_T、IDU_R 五个目录，每个目录有完整的 `process.json`、`collect.json`、`transmit.json`。目录名可与板卡类型代码不同，由清单明确关联；同类型板卡实例共用配置。

各表必须包含 `version: 1`、`enabled`、`label`、`description`、`columns`、`editor`、`ordering`、`inline` 和 `fields`。字段元数据直接保存在本表中，不读取公共默认或项目覆盖文件。空 `inline` 使单元格只读，`enabled: false` 隐藏入口；DSP 采集表当前隐藏。`project.json.workspace.boards` 为所有类型指定页签顺序，转发表使用 `transmit` 标识。

迁移时复制完整项目目录，包括清单引用的来源文件；路径必须位于项目内。`PROJECT_CONFIG_DIR` 为这些项目目录的父目录，默认 `config`；更改这个环境变量需重启服务。目录内的项目、板卡及点表定义实时读取，刷新页面即可读取更新。配置缺失或格式错误会报告对应文件路径。

单纯隐藏表格或调整列显示不需要数据库迁移，也不删除记录或改变成员权限；运行本版程序需要应用至迁移 0015。`point_storage`、`point_groups`、`point_endpoints` 属于已应用项目配置，修改后需要通过配置导入生效。

## 更新项目拓扑

拓扑在服务器的 `config/<项目名>/project.json` 中维护，网页只读显示其 `topology` 内容。修改并保存文件后，在网页打开项目配置窗口，重新读取服务器文件，检查差异并导入；导入沿用项目全部编辑权限、编辑权、版本检查和审计。仅读取文件不会写入数据库。

挂载数量、协议、板卡类型、目录和显示定义都会实时读取。新增类型先准备完整板卡目录，再检查导入；`workspace` 和单表显示定义刷新页面即可更新。数据库保留项目标识及 `projects.topology_config` 生效快照，文件内容经校验导入后才更新该快照。DSP 内部点和转发表继续在网页编辑。

## 导出与导入项目文件夹

在来源服务器执行：

```bash
node scripts/export-project.mjs upm
# 或指定导出父目录，结果为 /tmp/project-export/upm/
node scripts/export-project.mjs upm /tmp/project-export
```

默认输出 `.runtime/exports/<时间>/upm/`，已有输出目录不会被覆盖。脚本读取 `.env`，需要 Node `pg` 驱动、`pg_dump`、`MIGRATION_DATABASE_URL` 及创建临时数据库的权限；源业务库只读。缺少驱动时执行 `npm install --prefix .runtime/db-tools pg`。客户端版本须兼容源数据库和归档版本，本地数据库默认 PostgreSQL 18。

导出目录包含原配置和 `project.dump`，清单增加 `"dump": "project.dump"`。这是 `pg_dump -Fc` 生成的专用单项目归档，内部承载白名单业务表数据，仅包含 DSP 的 `process_points`、`transmit_points`；它不包含账号、会话、成员授权、`point_history`、通用历史审计和发布包。普通全库 Dump 不能用于网页项目导入。归档记录的迁移版本必须与目标程序支持的版本一致；版本不同时先统一程序与数据库版本，再重新导出。未设置 `dump` 时也可识别项目根目录唯一的 `.dump` 文件；多个归档会被拒绝。

目标服务器初始化数据库并启动应用后，管理员在「项目设置 → 导入项目文件夹」选择完整目录；无项目时可从空页面导入。预览会检查配置、关联和数据，确认后同 `key` 覆盖配置、新 `key` 建立项目：

- **带 Dump**：替换该项目的内部点和转发映射；保留其他项目与已有账号、`point_history`、审计及发布历史，本次 DSP 替换也追加修改历史。
- **不带 Dump**：保留现有点表，新项目为空点表。即使文件夹包含 XLSX，也不会触发工作簿导入。需要仅导入配置时，移除 Dump 文件及清单中的 `dump` 引用。

每次最多 512 个文件、64 MiB，预览 30 分钟有效。其他成员持有编辑权、项目版本或服务器文件已变化时，需要处理提示并重新预览。导入只调用 `pg_restore` 输出归档内容，由程序解析白名单数据并在项目事务内写入，不执行上传归档中的 SQL。服务账号需要项目根目录写权限；网页无需迁移管理员凭据。

每个 `PROJECT_CONFIG_DIR` 由单个服务实例管理。隐藏 `.imports/` 保存私有预览和导入恢复日志，过期预览在启动时清理。若进程中断或数据库提交结果不明确，服务会返回 503；重启会核对提交记录并恢复目录状态。不要手动删除尚未恢复的导入日志。

项目 Dump 是导出时的快照；后续网页编辑不会自动更新该文件。再次迁移前重新导出。需要完整账号、权限和历史时，使用下面的全库备份流程。

## 全库备份

使用具备备份权限的管理员连接，不能使用被 RLS 限制的项目身份进行全库备份。使用 `.pgpass` 或受控的 `PGPASSWORD` 提供密码，不提交密码到源码。

```bash
pg_dump -h DB_HOST -U postgres -d protocol_studio -Fc -f protocol_studio.dump
```

备份包含用户密码散列和会话，需要按业务数据库的访问权限存储。`.env`、TLS 配置等部署信息单独保管。

该全库备份同时包含 DSP 当前数据、`point_history` 和不可变发布记录。项目业务 Dump 只携带当前项目数据，不能用来恢复完整历史；需要把修改记录迁移到另一台机器时，使用全库备份并复制匹配的配置目录。

## 迁移到其他 PostgreSQL

1. 在目标服务器创建空数据库和 `protocol_app` 非超级用户角色。
2. 使用管理员恢复：

   ```bash
   pg_restore -h NEW_HOST -U postgres -d protocol_studio --no-owner protocol_studio.dump
   ```

3. 确认表和安全定义函数由迁移管理员拥有，运行角色不拥有表。恢复工具使用的用户应为受信任的迁移管理员。
4. 更改部署环境的两条数据库连接，运行 `protocol-server migrate` 应用新增迁移。
5. 检查平台登录、工程师编辑、只读禁写与跨项目隔离后切换服务。
6. 若希望所有人重新登录，可由管理员执行 `DELETE FROM sessions`。

版本发布包用于固件交付，不是数据库备份。项目文件夹用于迁移指定项目的配置和点表；跨实例完整工作空间迁移使用全库 pg_dump / pg_restore，并另行复制项目配置目录。

## 升级与回退

先备份，再运行新版本迁移，随后启动新服务。已应用的迁移文件不能直接修改，否则 SQLx 校验和检查会报错；应追加新迁移。需要回退数据模式时，使用已验证的反向迁移或从备份恢复。

点表编辑与排序需要迁移 `0009_point_display_order.sql` 和 `0010_change_merge.sql`，分别增加独立显示顺序和预览合并基线，不重编已有 sigID 或协议地址。升级后同时部署前后端；旧预览没有合并基线时仍严格检查版本。发布接口现在要求携带生成预览返回的 `revision`。

迁移到其他电脑时运行 `cargo fetch --locked` 准备锁定的 Rust 依赖（包括 `json-patch`），再构建。可先用 `scripts/check-env.sh` 查看缺少的工具、库与配置。点表排序和编辑通过重新导出的项目 Dump 或全库备份迁移。

当前只生成 DSP JSON/XML 和项目快照，旧关系图的 C 生成流程已移除。平台不会自动改写原工作簿或固件工程。


## 可选容器部署

Dockerfile 和 Compose 提供独立部署方式，容器构建需在目标环境验证。配置 `.env` 中的 `POSTGRES_PASSWORD`、`POSTGRES_APP_PASSWORD`、`ADMIN_PASSWORD` 后运行 `docker compose up --build -d`。默认监听本机 8080；内网部署可设置 `HTTP_BIND=0.0.0.0`，HTTPS 代理下设置 `COOKIE_SECURE=true`。不会自动创建业务项目。
