# JSON 与 JS 板卡配置

板卡名称只作为标识和显示文字。Rust 负责通用存储、导入、校验和事务；JSON 声明组织和表格，板卡业务差异由每张表的 JS 处理。复用处理、采集、转发模型及现有 UPP / Modbus 能力时，新增项目、板卡、自定义元数据字段和规则无需修改 Rust、Vue 或数据库表。全新协议编码、存储关系或控件类型仍需扩展通用引擎。

处理表可选 `hidden_source_sig_ids: ["※"]`：当原始 `source_sig_id`（或 `metadata.source_sig_id`）匹配标记且 `sig_id` 为空时，在处理表和总体视图默认隐藏该点；查看开关可显示并编辑。分配编号后自动恢复显示。此配置不影响存储、关联或协议生成，最多 16 个标记、每个最多 64 字节。

采集端点可配置 `subset_of: {"board_key":"SOURCE_BOARD","endpoint_key":"OUT"}`，引用另一 native 板卡协议相同的转发端点。采集只包含所需源项，六个协议字段（`upp_model`、`address`、`wire_type`、`wire_length`、`scale`、`access`）须唯一匹配；源修改在预览事务中同步已有采集项，接收端调度与字节序独立保留。权限不足、源删除或存储表示不兼容时整笔拒绝。规则加载不重写点；已有项目须经拓扑配置导入应用。详见 [UPM 子集与同步](upm.md#dsp-转发子集)。

## 新增板卡

1. 在 `config/<项目>/` 创建板卡目录，准备完整的 `process.json`、`collect.json`、`transmit.json`。不使用的表设置 `enabled: false`。
2. 在 `project.json` 的 `topology.board_types` 增加唯一 `code`、`model_code`、`name`、`directory`，设置 `point_storage: "native"`。
3. 配置 `point_groups` 和 `point_endpoints`，并在 `workspace.boards` 指定显示表格，在 `roots` / `mounts` 定义拓扑。已有点或权限引用的键保持稳定。
4. 表格有自定义字段或规则时，在表 JSON 增加 `behavior` 并引用同目录的 JS 文件。脚本处理输入规范化、显示、校验及白名单字段联动；新增数据写入已有 `metadata`。见 [点表行为脚本](table-behavior.md)。
5. 需要 Excel 导入时，设置板卡的 `workbook_import: "workbook.json"`。项目首次创建导入还需配置 `workbook` 和 `workbook_boards`。
6. 网页导入项目文件夹，或在服务器修改后通过“项目配置”预览应用。无 Dump 不替换现有点表；随后可网页导入 Excel，或执行 `cargo run -- import-board <项目> <板卡>` 做首次初始化。

## 多个根板卡与共享下级

`topology.version: 3` 使用 `roots: [{"type":"CONTROLLER_A","quantity":1},{"type":"CONTROLLER_B","quantity":1}]`，列出所有没有上级的板卡；不再填写 `root`。`mounts` 可由不同 `parent` 指向同一个 `child`，每条连接独立配置协议和传输方式。同一对父子只声明一次，多种协议放在该关系的 `connections` 内。

共享节点表示同一组实际设备。例如两个数量均为 1 的主站，各以 `quantity: 24` 连接同一块板卡类型时，项目中该类型总数为 24，其下级也只计算一次。所有上级推导的总数必须一致；数量不一致、环路、重复连接或未声明的根板卡都会拒绝导入。界面只绘制一个共享节点，并展示所有上级及连接。版本 1、2 的单根树配置继续兼容；需要多个根或多个上级时显式改用版本 3。无需新增数据库表或迁移。

## 拓扑图自动整理

“项目拓扑”使用 [ELK.js](https://github.com/kieler/elkjs) 的分层布局，自动安排节点顺序、独立连接端口、曲线或直角走线和协议标签。默认使用平滑曲线，数量与协议直接显示为文字，不带方框。排序由减少交叉的布局算法决定；输入按稳定板卡键与连接键排序，重新排列 JSON 数组不会打乱同一拓扑的位置。

右上角可切换“横向布局／纵向布局”、“平滑曲线／直角折线”，或点击“自动整理”。这些设置仅影响当前页面显示，不需要获取编辑权，不写入配置或数据库，也不增加项目版本。节点仍可点击进入点表。布局在浏览器后台 Worker 计算；快速切换方向或线型会取消旧任务。失败时显示错误，可重新整理。

实现位于 `frontend/src/domain/topologyLayout.ts`（布局输入与结果）、`topologyWorker.ts`（后台引擎）和 `pages/ProjectTopology.vue`（绘制与控件）。引擎只在显示拓扑时加载，不影响点表规则或协议布局计算。

## 点表行为

每张 native 表的 `behavior` 引用同步 `export function behavior(context, parameters)`。`normalize` 接收用户提交并转换为存储字段；`project` 提供列值；`reconcile` 在完整修改后联动本表声明字段；`validate` 返回业务错误和警告。脚本不能绕过身份、权限、历史、引用和协议安全检查。DSP 的 25 列别名、DateType 推导、分类模型、转发名称和转换规则位于板卡目录内的 `process.js`、`transmit.js`。

前端通用展示参数通过 `presentation` 声明分类筛选、搜索提示、计算依赖和来源建议；不要根据板卡名或某个特有字段名增加组件分支。每张表的 `fields` 定义标签与已有控件类型。

`point_rules` 保留通用协议约束与旧配置兼容项：

| 属性 | 作用 |
| --- | --- |
| `sheet_layout` | 旧来源工作表能力标记；新展示与推导放在表级 `behavior` |
| `category_models` | 旧分类映射兼容项；当前 DSP 的实际映射在 `behavior.parameters` |
| `value_options` | 旧来源字段选项兼容项；当前表单选项在 `fields`，规则在表级脚本 |
| `raw_representation` | 通信类型和长度必须与内部存储一致，支持数组 |
| `inherit_name` | 转发表名称继承内部点 |
| `source_range_warnings` | 未更改的来源范围问题保留警告；后续非法修改拒绝 |
| `warn_missing_sig_id` | 缺少 sigID 时提示，不编造编号 |
| `null_callbacks` | 视为无回调的兼容字符串，例如 `"0"` |

`sheet_layout` 与 `raw_representation` 不能同时启用。分组的 `collect_enabled: false` 禁止该组采集，省略时允许。`devices` 声明共用模板的实例及独立 `dev_id`、`modbus_base`。端点声明 `protocol: "UPP" | "MODBUS"`、`direction: "collect" | "transmit"`；采集目前支持 UPP。

## 工作簿映射

路径限定在板卡目录内。一个 JSON 描述该板卡的所有来源 Sheet，例如：

```json
{
  "version": 1,
  "process": [{
    "sheet": "内部数据", "group": "LOCAL",
    "fields": {
      "name": {"column": "A"},
      "enum_name": {"column": "B", "transform": "enum"},
      "internal_type": {"column": "C", "transform": "upper"},
      "byte_length": {"column": "D", "kind": "integer"}
    }
  }]
}
```

`collect`、`transmit` 同样为来源数组，另需 `endpoint` 和 `reference`（内部点的枚举列）；引用按组和枚举解析。`fields` 仅允许已有业务字段，`metadata` 保存来源信息，禁止映射系统 ID。所有行保留原 Sheet、行号及单元格来源。

字段支持 `column`、固定 `value`、空值 `default`、`kind`（text/integer/number/boolean）、`strip_prefix`、`transform`（enum/upper）、`null_values`、`lookup` 和 `cases`。`conditions` 按列的 equals/contains/starts_with/not_empty 筛选行，多个条件取交集。命名 lookup 通过另一张 Sheet 的键和值列建立映射；重复键只有值相同才允许。

完整示例见 DSP、UPM 的 `workbook.json`。重复内部枚举默认拒绝；`merge_equal: true` 仅合并类型、sigID、范围等定义相同的记录，并保留多条转发和来源行。Excel 只读取缓存值，不运行公式；布局计算另见 [点表计算规则](table-calculation.md)。

工作簿映射产生规范存储行：处理表不调用表单 `normalize`，自定义字段映射到 `metadata` 子键。采集与转发可通过 `normalize` 的 `"import"` 操作补齐所需派生值，处理点投影来自完整导入列表。导入不自动执行 `reconcile` 或布局重算，规则持有字段不一致会被校验拒绝；详见 [导入与表行为的边界](table-behavior.md#excel-与文件夹导入)。

导入预览冻结映射和已应用板卡配置；任一内容变化都要求重新预览。应用新规则、导入、编辑依然受权限、编辑租约、版本冲突检查和历史记录约束。

## 只读派生采集设备

`point_storage: "derived"` 可定义只有一张 Modbus 采集表的设备；不创建或保存独立点记录。`collect.json` 的 `mapping` 通过 `source` 引用 native 板卡的 Modbus 转发端点，并用板卡目录内的 `script_file` 展开设备地址。Rust 引擎校验完整覆盖、合法引用、地址范围和冲突。界面、生成与发布均使用同一份实时映射。配置示例及 JS 输入输出约束见 [upm-demo](upm-demo.md)。
