# DC-UPS 项目库分组迁移记录

2026-10-19 17:14（Asia/Shanghai）完成本机项目库升级，并重启 HTTP 服务。

## 迁移结果

- 平台库仍为 `protocol_platform`，保留 8 张账号、权限及登记相关表。
- 项目库仍为 `protocol_project_dc_ups`，由 11 张表合并、分组为 7 张表。
- 项目 key、UUID、点 ID 和转发关联保持不变；配置仍来自 `config/dc-ups/`。
- 项目迁移版本为 2，`schema_version` 由 4 升至 5，`revision` 由 4 升至 5。
- 本次迁移前没有待提交预览；迁移机制会清空旧修改/导入预览并防止 ID 复用。

| Schema | 表 | 迁移后记录数 |
| --- | --- | --- |
| `points` | `process_points` | 552 |
| `points` | `transmit_points` | 445 |
| `history` | `events` | 1,000：点变化 997、项目审计 2、导入 1 |
| `history` | `releases` | 0 |
| `meta` | `project_state` | 1，含编辑权字段 |
| `meta` | `previews` | 0，按 kind 区分修改与导入 |
| `public` | `_sqlx_migrations` | 2 个已应用迁移 |

## 备份与核对

升级前停止旧服务，备份目录：

```text
.runtime/backups/dc-ups-schemas-2026-10-19T09-14-03-328Z/
```

目录包含平台库、项目库的完整 custom Dump、配置目录、旧服务二进制，以及权限受限的环境副本和核验记录。两个 Dump 均通过目录解析及 SHA-256 核验。该目录不纳入 Git；恢复时须停服并使用匹配的数据库、程序和配置。

当前点表逐行摘要与迁移前相同；合并事件按旧字段投影核对，997 条点历史、2 条审计、1 条导入的全部原内容均一致。发布内容和已有租约同样核对。重复执行迁移没有增加版本或重复历史。旧停用库 `protocol_studio` 未改动。

## 验证

- `cargo fmt --check`、`cargo build`、`cargo test`：通过，72 项 Rust 测试。
- 独立 PostgreSQL 迁移套件：通过，覆盖旧库拆分续跑、七表升级、序列高水位、历史保留、RLS 和幂等。
- HTTP 集成测试：4,821 项断言通过，包含编辑、合并、预览归属、新旧 Dump、权限撤销及项目隔离。
- 前端构建与浏览器回归：通过。
- 真实服务：登录、项目概览、权限、编辑权、审计、发布接口通过；浏览器显示 DSP 内部数据 552 条及转发映射 445 条，无页面异常，未提交业务修改。

在 DBeaver 中刷新或重连 `protocol_project_dc_ups`，显示 `points`、`history`、`meta` 三个 Schema。`public` 下只保留迁移记录表，查询应使用完整名称，例如 `SELECT * FROM points.process_points;`。
