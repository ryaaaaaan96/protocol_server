# 归档前架构检查

检查日期：2026-10-21。结论：**复用现有点表、协议和控件契约的新项目，可以只增加项目 JSON／JS；前后端源码和构建已分离，通过 HTTP API 协作。** 这不是任意协议或任意数据库模型的插件平台，也不要求每个新项目修改 Rust／Vue。最小项目保留在 [examples/minimal-project](../examples/minimal-project/README.md)，验收不复制 DC-UPS。

## 按职责分类

| 类别 | 实现位置 | 新增项目是否改代码 |
| --- | --- | --- |
| 项目、板卡、拓扑、分组、设备实例、端点、来源子集 | `config/<key>/project.json` | 只增加 JSON |
| 三类点表、列、标签、选项、已有编辑控件、筛选和展示 | 板卡目录的 `process.json`、`collect.json`、`transmit.json` | 只增加 JSON |
| 自定义元数据、建议、规范化、投影、业务校验与声明字段联动 | 表级 `behavior` JS 及参数 | 只增加 JSON／JS |
| 地址／长度计算、实例地址、只读派生采集 | `calculation`、`instance_calculation`、`mapping` | 既有契约内只改 JSON／JS |
| Excel 来源 Sheet、字段转换、条件筛选和引用 | 板卡 `workbook.json` | 既有映射算子内只改 JSON |
| 通用存储与引用、账号／权限、RLS、租约、版本合并、预览、历史 | `src/`、活动数据库迁移 | 平台公共能力，不随项目复制 |
| 表格编辑、总体视图、拓扑布局、列设置、HTTP 客户端 | `frontend/src/` | 公共页面读服务端定义，无板卡组件分派 |
| JSON／Excel 导出、协议生成、不可变发布 | `src/table_export.rs`、`topology_codegen.rs`、`native_points.rs` | 现有格式与协议内无需修改 |

项目配置的生效快照保留在项目库，供引用、授权、预览及恢复使用；编辑来源仍为文件。数据库中的快照不是另一套前端拓扑编辑模型。项目业务库、平台账号库分离，一个板卡不单独建库。

## 前端与后端的分离程度

- **源码／依赖／构建分离：通过。** `frontend/` 使用 Vue、TypeScript、Vite；Rust 使用 Cargo。前端不导入项目目录或直接访问数据库。
- **业务边界分离：通过。** 前端调用 `/api`，消费表定义、投影行、权限与校验结果；JS 规则在后端受限运行。身份、地址安全和事务不下放给浏览器或项目脚本。
- **分别部署：支持同源代理。** 可独立托管 `frontend/dist/`，将同一站点的 `/api` 代理到 Rust；开发期 Vite 已提供代理。Rust 托管静态文件只是默认部署方式。
- **不同域名直接调用：未提供通用配置。** 当前客户端使用相对 `/api`、同源 Cookie 和 CSRF 请求头，没有跨域 CORS 契约。需要时另行设计；归档版本按同源部署验收。

## 配置扩展的边界

| 需求 | 当前支持范围 |
| --- | --- |
| 点数据模型 | 处理、采集、转发三类；自定义值存白名单 `metadata`，不任意创建 SQL 表或关系 |
| 原生协议 | UPP 采集；UPP／Modbus 转发。Modbus 地址单位是寄存器，UPP 是字节 |
| 派生设备 | 一个 Modbus 只读采集端点，完整展开已声明来源；不保存副本 |
| 自定义字段 | 现有文本、数字、布尔、选项、引用控件及服务端投影；全新控件需改公共前端 |
| 规则脚本 | 同步、受限 JS；不能读文件、网络、数据库或使用 npm、异步宏。TS 需先编译为 JS |
| 导入与生成 | Excel 读取缓存值，不执行公式／WPS 宏；新解析器、协议编码、固件专用输出格式需扩展公共后端 |

因此，“新增项目不改前后端”适用于组合已有公共能力；新平台能力要先实现一次，再供各项目复用。规则更改不会悄悄覆盖旧点值，已有布局改变仍须预览重算。

## 本次检查与修复

1. 清理 Excel 导入提示和 SQL 查询示例中的项目／板卡固定名称；SQL 工作台展示迁移 0001～0004，并使用限定 Schema 的默认查询。
2. 最小项目发现 `calculation` 曾把 Modbus 长度当 UPP 字节跨度，误拒绝连续寄存器。现从配置端点传入协议，按相应地址单位检查边界；Modbus 重叠由通用协议校验器按最终设备地址和寄存器区检查，保留原子回滚。
3. 新增独立项目验收：完整文件夹导入、配置默认分组／端点、自定义字段、三类点表编辑、非法值拒绝、参数即时重载、Modbus 地址计算与真实冲突拒绝、生成和 JSON／Excel 导出。可选真实浏览器检查拓扑入口、配置列、单元格编辑与保存、三类表及总体视图，直接访问同一构建的服务与 API。
4. 文件夹归档比较统一 Rust 序列化补充的默认值（如省略与显式 `modbus_base: 0`），避免误报拓扑未应用；实际设备地址、实例序号、协议和数量变化仍会拒绝导出。
5. `tests/references/` 的旧导入器只在测试编译；`import-upm` 是兼容 CLI 别名。DC-UPS Excel 上传示例、旧分库迁移脚本及回归夹具中的名称属于示例／历史兼容，不是新项目注册机制，保留而不批量替换。

## 归档验收与使用

```bash
cargo fmt --check
cargo test --locked
cargo build --locked
npm run build --prefix frontend
node tests/integration.mjs --onboarding --browser
node tests/integration.mjs --behavior
node tests/integration.mjs --generic
node --test tests/export-topology.mjs
node frontend/browser-check.mjs
```

本次通过：Rust 137 项；独立项目（含真实浏览器）89 项；表行为 268 项；通用板卡 71 项；拓扑归档比较 2 项；前端类型检查、构建和完整浏览器回归。未修改业务项目，无数据库结构迁移。

独立项目模式只从 `examples/minimal-project/` 建立临时配置和数据库。`--behavior` 验证白名单、脚本冻结、过期规则、关联事务及错误回滚；`--generic` 验证陌生板卡／分组／端点的工作簿导入和生成。浏览器依赖及数据库前提见 [最小项目说明](../examples/minimal-project/README.md)。文件夹归档还需 `pg_dump`（可用 `PG_DUMP_BIN` 指定）；本次使用本机已有 PostgreSQL 18 客户端。

新增项目：复制模板到 `config/<key>/`，修改 key／名称及配置，再用网页文件夹导入或已安装的可执行文件 `protocol-server create-project <key>` 创建；不必重新构建程序。模板没有内置点数据，首次为空，随后网页编辑或配置 Excel 来源。

归档代码应保留锁文件、活动及旧迁移、配置与来源样本、示例和测试。`.env`、`.runtime/`、依赖目录、构建产物继续忽略。可移植项目 Dump 仅包含当前点，不能替代含历史／账号的完整数据库备份。代码归档不等于固件协议验证，也不自动创建 Git 标签或发布包。
