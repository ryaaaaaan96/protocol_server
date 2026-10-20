# JSON 板卡配置

板卡名称只作为标识和显示文字。Rust 负责通用存储、导入、校验和事务；板卡差异由 JSON 声明。复用现有内部字段、UPP 采集/转发、Modbus 转发和布局规则时，新增板卡无需修改 Rust、Vue 或数据库表。全新协议编码或新的业务字段类型仍需扩展引擎。

## 新增板卡

1. 在 `config/<项目>/` 创建板卡目录，准备完整的 `process.json`、`collect.json`、`transmit.json`。不使用的表设置 `enabled: false`。
2. 在 `project.json` 的 `topology.board_types` 增加唯一 `code`、`model_code`、`name`、`directory`，设置 `point_storage: "native"`。
3. 配置 `point_groups` 和 `point_endpoints`，并在 `workspace.boards` 指定显示表格，在 `root` / `mounts` 定义拓扑。已有点或权限引用的键保持稳定。
4. 需要 Excel 导入时，设置板卡的 `workbook_import: "workbook.json"`。项目首次创建导入还需配置 `workbook` 和 `workbook_boards`。
5. 网页导入项目文件夹，或在服务器修改后通过“项目配置”预览应用。无 Dump 不替换现有点表；随后可网页导入 Excel，或执行 `cargo run -- import-board <项目> <板卡>` 做首次初始化。

## 点表行为

`point_rules` 可配置：

| 属性 | 作用 |
| --- | --- |
| `sheet_layout` | 使用来源工作表的字段别名和隐藏元数据，如 DSP 的 25 列；不由板卡名选择 |
| `category_models` | 分类到 UPP 模型号的固定映射，用于 `sheet_layout` |
| `value_options` | 工作表元数据字段允许的字符串选项 |
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

导入预览冻结映射和已应用板卡配置；任一内容变化都要求重新预览。应用新规则、导入、编辑依然受权限、编辑租约、版本冲突检查和历史记录约束。
