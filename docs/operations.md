# 部署与数据库迁移

## 配置职责

| 参数 | 用途 |
| --- | --- |
| DATABASE_URL | HTTP 服务使用的 protocol_app 非超级用户连接 |
| MIGRATION_DATABASE_URL | 仅 migrate 命令使用的迁移管理员连接 |
| ADMIN_USERNAME / ADMIN_PASSWORD | 数据库为空时创建首个管理员，后续不会重置现有账号 |
| BIND_ADDR | Rust 监听地址，默认 127.0.0.1:8080 |
| COOKIE_SECURE | HTTPS 环境设为 true |
| STATIC_DIR | 生产前端目录，默认 frontend/dist |
| POINT_TABLE_CONFIG | 点表展示配置路径，默认 config/point-tables.json；修改后重启后端生效 |
| PROJECT_CONFIG_DIR | 项目配置的父目录，默认 config/projects；每个子目录提供 project.json 和可选 point-tables.json |

不要把迁移管理员连接作为运行连接。本版迁移给名称为 `protocol_app` 的角色授权；如采用其他角色名，需在部署时单独授予等价权限并测试 RLS。

## 本地数据库与项目分开创建

首次运行 `./scripts/init-db.sh` 明确创建本地数据库、应用角色和表结构，不创建业务项目。随后由管理员运行 `./scripts/create-project.sh upm`，从 `config/projects/upm/project.json` 创建项目，最后运行 `./scripts/dev.sh` 启动应用。已经初始化的数据库可用 `node scripts/local-db.mjs start` / `stop` 单独控制；启动应用和数据库不会自动初始化新库。

外部 PostgreSQL 使用已有的数据库管理流程创建空库和运行角色，执行 `cargo run -- migrate` 安装表结构后，同样可以运行项目创建脚本。项目创建只需要运行数据库连接，仍通过管理员上下文、RLS 和事务写入。运行角色不得拥有表或绕过 RLS。创建脚本重复运行会保留已有项目，导入失败则整体回滚；它不是同步或恢复已有项目的工具。

本地模式的 `.runtime/pgdata/` 保存完整业务数据库；`.runtime/` 被 Git 忽略，不能整体当缓存删除。`config/projects/` 可随代码迁移，提供创建时的拓扑和可选 Excel 来源，以及运行时的展示定义；网页中修改的点表、用户和权限仍以数据库为准。恢复旧电脑的数据时，使用下面的数据库备份流程，勿先初始化表结构或创建同名新项目到恢复目标。

## 备份

使用具备备份权限的管理员连接，不能使用被 RLS 限制的项目身份进行全库备份。使用 `.pgpass` 或受控的 `PGPASSWORD` 提供密码，不提交密码到源码。

```bash
pg_dump -h DB_HOST -U postgres -d protocol_studio -Fc -f protocol_studio.dump
```

备份包含用户密码散列和会话，需要按业务数据库的访问权限存储。`.env`、TLS 配置等部署信息单独保管。

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

版本发布包可以跨环境交付到固件工程，但不是数据库全量备份。JSON 导出包含项目源数据，当前版本尚无通用 JSON 导入界面；跨实例完整迁移使用 pg_dump / pg_restore。

## 升级与回退

先备份，再运行新版本迁移，随后启动新服务。已应用的迁移文件不能直接修改，否则 SQLx 校验和检查会报错；应追加新迁移。需要回退数据模式时，使用已验证的反向迁移或从备份恢复。

代码生成遵循参考工程接口，目标固件的宏、回调实现和 ABI 由目标工程提供。平台不会自动改写参考工程，也不会将生成文件直接覆盖进固件目录。

## 本次拓扑升级

从旧平面点表升级时，先停止旧 HTTP 进程，备份数据库，然后使用新二进制执行 `protocol-server migrate`，最后启动新服务。迁移保留旧 points/devices 档案，但旧 API 的写权限已撤回，因此不要继续运行旧后端。

本地可先执行 `node tests/migration.mjs` 验证独立旧数据库升级。若提供本地 JSON 备份路径作为参数，测试会将其中旧业务数据装入临时数据库，验证真实数据迁移与重复执行；不会改写备份或现有项目。完整跨机器备份仍使用 pg_dump / pg_restore。
