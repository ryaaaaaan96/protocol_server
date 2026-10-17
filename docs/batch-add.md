# 点表批量添加

本次提供批量追加 API 和可运行的 Node.js Excel 示例。网页批量弹窗可按下述步骤接入同一 API；当前网页仍使用已有的单条「新建」。批量添加修改业务数据，与浏览器本地的列显示设置无关。

## 添加步骤与界面约定

1. **选择范围**：选择项目、板卡和点表。处理点表（DSP 内部数据）选择分组；采集、转发选择端点和逻辑设备。
2. **填写多行**：处理点填名称、枚举、sigID、已有数据定义及可选范围；采集、转发选择已有处理点，再配置对应的已有协议字段。
3. **校验预览**：未来「批量添加」弹窗支持粘贴 Excel 多行、连续编辑，统一检查后列出行号、字段错误和关联影响。内容改变后，原预览作废。
4. **确认追加**：全部通过后提交，成功提示新增数量并刷新；失败显示浮窗并保留输入。每批 1～200 行，全部成功或全部回滚。
5. **处理冲突**：无关并发修改可合并；引用的分组、数据定义、设备或协议布局变化时重新预览；编号重复、映射冲突或范围不合法时修正对应行。

采集和转发只创建绑定，不复制处理点。数据定义、分组、端点、上下文及协议字段须先存在，第一版不隐式创建依赖。使用稳定的英文字段名，与列隐藏、冻结、拖动及中文显示标题独立。

## 运行 Excel 示例

需要 Node.js 22+、运行中的新版后端，以及项目管理员或工程师账号。示例使用 [ExcelJS 4.4.0（MIT）](https://github.com/exceljs/exceljs/tree/v4.4.0) 读写 `.xlsx`，依赖只安装到脚本目录。迁移时保留 `package.json` 与锁文件，再运行安装命令。

```sh
npm ci --prefix scripts/excel-batch
node scripts/excel-batch/index.mjs --help

# 离线生成模板，工作表名为 process，第一行为英文字段名
node scripts/excel-batch/index.mjs --kind process --template points.xlsx
```

模板包含字段批注和「填写说明」。账号通过环境变量 `PROTOCOL_USERNAME`、`PROTOCOL_PASSWORD` 提供；也可设置已有的 `PROTOCOL_SESSION`（64 位会话令牌）。脚本不读取仓库 `.env`，不打印凭据；账号登录时结束后注销自己的会话，使用已有令牌时保留原会话。

以下项目 `1`、板卡模板 `2` 是占位值，应替换为自己的 ID。可从页面网络请求的 `projects/{pid}/board-models/{mid}` 路径查看；板卡模板 ID 不等于板卡实例 ID。

```sh
# 登录环境变量已设置。导出合法引用 ID，用于填写模板
node scripts/excel-batch/index.mjs --project 1 --model 2 --kind process --references refs.json

# 填写 points.xlsx 后校验，保存完整预览，不保存业务数据
node scripts/excel-batch/index.mjs --project 1 --model 2 --kind process --file points.xlsx --report preview.json

# 重新校验并正式提交，输出实际记录 ID、来源行号及新版本
node scripts/excel-batch/index.mjs --project 1 --model 2 --kind process --file points.xlsx --commit --report result.json
```

`--url http://127.0.0.1:8080` 指定服务地址，默认即此地址；`--sheet 工作表名` 指定读取的单个工作表。采集、转发用 `--kind collect` / `--kind forward`，先生成对应模板。模板、引用文件和报告均不覆盖已有文件；重复运行请使用新报告名。

处理点模板最小示例（ID 仅示意）：

| group_id | data_item_id | name | enum_name | sig_id | min_value | max_value |
| --- | --- | --- | --- | --- | --- | --- |
| 10 | 20 | 母线电压 | DSP_BUS_VOLTAGE | 101 | 0 | 1000 |
| 10 | 20 | 输出电压 | DSP_OUTPUT_VOLTAGE | 102 | 0 | 1000 |

采集、转发至少需要 `endpoint_id`、`context_id`、`signal_id`、`field_id`。从 `refs.json` 的 `options` 查 ID：`groups` 为分组，`data` 为数据定义，`signals` 为处理点，`contexts` 为逻辑设备，`endpoints` 为端点，`fields` 为协议字段。采集端点必须是 `client`，转发必须是 `server`；上下文必须使用对应处理点分组，字段必须属于端点协议。

解析规则：

- 必填列可以换序，可选列可省略；未知、重复表头或无表头的数据列报错。
- 从第 2 行读取，跳过完全空行，保留 Excel 行号；其他工作表不会提交。
- 空值表示省略，采用数据库默认值或继承数据定义。处理点默认 `process_enabled=true`；不参与处理表时明确填 `false`。参与处理表的点须提供有效 `sig_id` 或已有 `sig_symbol`，二选一。
- 编号接受十进制或 `0x` 整数；布尔值接受 `true/false`、`1/0`、`是/否`。范围、宏与标志按文本提交。超出 JavaScript 安全精度的数字不会被静默转换。
- 公式、日期、富文本和合并单元格不接受；公式请先粘贴为值。最多 15 MB、200 条数据，不自动拆批。
- 失败退出码为 1，成功为 0。正式提交响应丢失时结果可能未知，先核实页面和审计记录，脚本不会自动重提。

## API 契约

所有路径以 `/api` 开头，通过 `/auth/login` 获取 `protocol_session` Cookie；POST 同时发送 `X-Requested-With: protocol-studio` 和 `Content-Type: application/json`。

### 1. 读取版本与引用

`GET /api/projects/{pid}/board-models/{mid}/point-tables/{kind}`

返回 `revision`、`rows`、`options`、`definition`；`kind` 为 `process`、`collect` 或 `forward`。

### 2. 批量预览

`POST /api/projects/{pid}/board-models/{mid}/point-tables/{kind}/batch/preview`

```json
{
  "revision": 12,
  "rows": [{
    "row": 2,
    "values": {
      "group_id": 10,
      "data_item_id": 20,
      "name": "母线电压",
      "enum_name": "DSP_BUS_VOLTAGE",
      "sig_id": 101,
      "min_value": "0",
      "max_value": "1000"
    }
  }]
}
```

`row` 是调用方的正整数来源行号，不得重复；省略 `operation` 或设为 `create` 时，`values` 字段与对应点表单条新建相同。业务校验失败返回 HTTP 200、`allowed:false` 和 `errors`；可定位的错误附带 `row`，字段格式错误附带 `field`。成功返回 `allowed:true`、预览 `id`、`impact` 和 `validation`。新增的初次预览版本过旧返回 HTTP 409，需读取最新版本并重新预览。

网页的单元格批量修改也使用此接口，设置 `operation:"update"`，每行提供已有记录 ID、增量字段和原始编辑值：

```json
{
  "revision": 12,
  "operation": "update",
  "rows": [{
    "row": 1,
    "id": 123,
    "values": { "name": "更新后的名称", "min_value": null },
    "expected": { "name": "原名称", "min_value": "0" }
  }]
}
```

更新不能混入新增行，记录 ID 和行号不能重复；`expected` 来自读接口的 `edit_values`，用于检测并发修改，不能使用显示出来的继承值替代。范围记录尚不存在时使用字段定义中的默认值（没有默认值则用 null）。修改字段未被他人改变时可基于最新版本重新预览；提交仍检查全部关系和约束。单批任意行失败则整批回滚，只增加一次 revision 和审计记录。现有 Excel CLI 仍只追加新增，不将重复上传解释为覆盖修改。

预览在事务中保存点及范围后回滚，仅保留预览记录，不增加业务版本。预览内的临时记录 ID 不能用于后续绑定。

### 3. 确认提交

`POST /api/projects/{pid}/changes/{preview_id}/commit`，请求体 `{}`。

复用已有提交入口，只有创建预览的用户能提交，有效期 15 分钟。服务端锁定项目、检查依赖、重新应用整批、校验拓扑、写审计，增加一次 `revision`。返回 `record.count`、`record.rows`（来源行号与真实记录）、`revision` 和 `merged`。

无关并发修改允许合并；引用记录或协议布局变化返回 HTTP 409 `REVISION_CONFLICT`。第一版比较依赖记录的整体内容，引用记录即使只改名称也需重新预览。重复提交已用预览会被拒绝；以新预览重传已有编号、映射也会报重复，不能作为覆盖更新使用。

此接口与原有 `/imports/preview` 不同：UPM 工作簿导入会重建项目拓扑，批量接口只操作当前板卡当前点表中明确指定的记录。

### 独占编辑接口

调用预览或提交前，先 `POST /api/projects/{pid}/edit-lock/acquire`，请求体 `{}`。通过 `GET /api/projects/{pid}/edit-lock` 查看 `{locked, owned, owner, expires_at, lease_seconds}`；持有者应在 120 秒租约到期前调用 `/renew`。他人占用或未持锁的写入返回 423，并附 `code` 与 `lock` 状态。预览不会释放，成功提交会原子释放；放弃本次操作可调用 `/release`。

Excel CLI 已自动获取和续租。仅预览模式在完成后主动释放，正式提交成功由服务器释放；如果其他人正在网页编辑，CLI 会提示占用并停止写入。

## 验证

```sh
node --test scripts/excel-batch/workbook.test.mjs
cargo test --offline
cargo build --offline
node tests/integration.mjs
```

集成测试包含真实 Excel 读写和 CLI 上传，需先安装脚本依赖；使用独立临时数据库，验证三类点表、范围、行错误、权限隔离、重复提交、并发合并及整批回滚。
