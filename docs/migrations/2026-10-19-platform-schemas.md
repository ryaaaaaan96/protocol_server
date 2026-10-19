# 平台库按职责分组迁移记录

2026-10-19 17:26（Asia/Shanghai）完成本机 `protocol_platform` 升级并重启服务。

## 当前结构

按用户确认的方案保留 8 张表，仅移动 Schema：

| Schema | 表 | 职责 |
| --- | --- | --- |
| `auth` | `users` | 登录账号、密码摘要与账号状态 |
| `auth` | `sessions` | 多设备会话、到期与注销 |
| `auth` | `login_attempts` | 登录失败次数及限流，包含不存在的用户名 |
| `meta` | `projects` | 项目身份、配置 key、数据库路由与创建状态 |
| `meta` | `project_members` | 成员角色及编辑范围类型 |
| `meta` | `project_member_grants` | 板卡、内部数据或协议端点授权 |
| `history` | `audit_logs` | 只允许追加的平台审计 |
| `public` | `_sqlx_migrations` | 数据库结构升级记录 |

平台迁移版本由 1 升至 2。账号、权限、登录限流规则、审计及项目登记内容均保留，外键、唯一约束、序列、RLS 和权限撤销时的事务锁顺序继续有效。

`protocol_project_dc_ups` 仍为 7 张表，迁移版本 2、业务结构版本 5、项目 revision 5；配置仍使用 `config/dc-ups/`。项目库所有表在升级前、迁移后、服务重启后均核对完整记录摘要，确认没有变化。

## 备份与实际验证

停服后生成两个数据库的完整 custom Dump，并保存配置目录、旧服务二进制及权限受限的环境副本：

```text
.runtime/backups/platform-schemas-2026-10-19T09-26-00-574Z/
```

备份通过归档目录解析及 SHA-256 核验，目录不纳入 Git。平台七张业务/运行表的完整记录摘要在迁移前后相同；重复执行迁移没有重写记录。恢复旧程序时须停服并使用匹配的备份及配置。

升级前创建的验证登录会话，在新服务中仍可读取当前用户、账号、项目成员、权限和 DSP 点表，验证结束后已注销。浏览器正常登录，显示 DSP 内部数据 552 条、转发映射 445 条，无页面异常。旧停用数据库 `protocol_studio` 未改动。

## 验证结果

- `cargo build`、`cargo fmt --check`、`git diff --check`：通过。
- `cargo test`：72 项通过。
- 独立 PostgreSQL 迁移测试：通过，覆盖完整记录、微秒时间、大整数 ID、对象与序列保留，权限约束、旧拆分续跑和幂等性。
- HTTP 集成测试：4,848 项断言通过，包含多会话登录、注销、登录限流、权限撤销、项目隔离、点表编辑和导入导出。
- 真实平台结构、运行账号权限、备份校验及浏览器验证：通过。

在 DBeaver 中重连或刷新 `protocol_platform`，展开 `auth`、`meta`、`history`。`public` 下只保留迁移记录表。手写 SQL 使用完整名称，例如：

```sql
SELECT id, username, display_name, active FROM auth.users;
SELECT config_key, name, database_name, status FROM meta.projects;
SELECT version, success FROM public._sqlx_migrations ORDER BY version;
```
