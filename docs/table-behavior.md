# 点表行为脚本

项目差异分为三层：JSON 声明组织和表格，JS 处理本表规则，Rust 执行通用存储与事务。增加使用现有处理、采集、转发模型的板卡，或增加一个存入 `metadata` 的字段时，可以只增加项目文件。

| 所属层 | 负责内容 |
| --- | --- |
| `project.json` | 板卡、分组、设备实例、端点、点表间的来源关系 |
| `process.json` / `collect.json` / `transmit.json` | 列、标题、编辑控件、默认值、字段权限声明、脚本文件及参数 |
| 每表的 JS | 输入规范化、显示投影、业务校验、声明字段的联动 |
| Rust | 记录与引用身份、数据库、权限、租约、版本合并、预览、历史、地址与类型安全、沙箱、生成及发布 |

前端根据 JSON 渲染已有的文本、数字、选项、引用等控件。JS 在服务端执行，浏览器取得计算后的行和校验结果。规则不需要在前后端各实现一份。

## 表定义

在完整的表格 JSON 中增加 `behavior`，并把新字段加入 `columns`、`editor`、`inline` 和 `fields`：

```json
{
  "behavior": {
    "engine": "javascript",
    "script_file": "process.js",
    "parameters": {"default_gain": 1},
    "editable_fields": ["calibration_gain"],
    "metadata_fields": ["calibration_gain"],
    "project_fields": ["calibration_gain", "calibrated_label"],
    "owned_fields": []
  },
  "fields": {
    "calibration_gain": {"label": "校准系数", "type": "number", "default": 1},
    "calibrated_label": {"label": "校准显示"}
  }
}
```

上例只是增量配置，不能替代完整的表格定义。字段名应使用字母、数字和下划线，不能以数字开头。

| 声明 | 含义 |
| --- | --- |
| `editable_fields` | 表单接受的自定义输入名称；必须同时列入 `project_fields` |
| `metadata_fields` | 脚本可以修改的 `metadata` 子键，其他子键必须完整保留 |
| `project_fields` | `project` 可以返回的显示值，包括可编辑字段的当前值 |
| `owned_fields` | `reconcile` 可以持久更新的通用业务字段 |
| `source_tables` | 可选 `["collect", "forward"]`；为每个处理来源提供只读 `collections`、`transmissions` 及 `endpoints` 上下文 |
| `linked_fields` | 可选 `["address"]`，仅用于无 `calculation` 的转发表；允许 `reconcile` 原子联动转发偏移，手动输入由本表 `normalize` 判断 |

自定义字段通过脚本映射到现有 `metadata`，不增加数据库列。`fields` 负责控件和标签，`behavior` 负责字段值，声明任意名字不会自动生成业务逻辑。

路径相对所属板卡目录，只接受目录内的 `.js` 普通文件。文件夹导入和导出携带脚本，不能引用其他板卡的脚本或使用路径跳转。每张表使用一个行为入口，可在同一个文件内定义辅助函数。

## 前端展示声明

`presentation` 只描述界面行为，不在浏览器计算业务公式：

| 参数 | 用途 |
| --- | --- |
| `category_filter` | 按指定字段提供分类筛选；字段须在 `fields` 中声明 |
| `search_placeholder`、`empty_text` | 搜索提示、空值文本 |
| `computed_dependencies` | `{计算列: [输入字段]}`；依赖被修改时显示“待计算”，保存后采用服务端结果 |
| `overview_hidden_fields` | 仅在总体视图隐藏的列，必须已列入 `columns`；省略时保留全部列 |
| `overview_leading_fields` | 处理表指定列排在总体视图最前，其余列在转发表后；省略时处理表按原顺序整体在前。转发表配置此项时仅调整其自身列顺序 |
| `suggestion` | 指定来源引用和服务端已计算的建议字段，允许用户主动采用建议 |
| `row_expansion` | `{field: "instance_rows", leading_columns: ["instance_device"]}`；把脚本显示字段中的对象数组展开为只读行，保留共享模板编辑入口 |

例如转发表可声明：

```json
{
  "presentation": {
    "computed_dependencies": {"effective_length": ["process_point_id", "wire_type"]},
    "suggestion": {
      "reference": "process_points",
      "source_key": "process_point_id",
      "fields": {"wire_type": "recommended_wire_type"},
      "description": "通信类型由来源处理点提供建议。"
    }
  }
}
```

`source_key` 必须是已声明的引用字段，其 `reference` 与建议配置一致。来源选项使用服务端提供的 `process_points`、`endpoints`、`native_groups` 等引用；`fields` 将目标列映射到来源属性。所需建议值缺失时不作浏览器推算。只有当前端点协议适用、同时列入 `editor` 的目标会被“采用建议”修改。

字段可配置 `protocols: ["UPP"]` 或 `["MODBUS"]`，也可同时包含两者；省略表示通用。独立协议视图隐藏不适用列，总体视图保留混合列，但不适用的单元格显示空值且禁止编辑。自定义字段通过既有文本、数字、布尔、选项或引用控件编辑；业务必填和取值约束由表脚本校验。

实例展开字段须声明在 `behavior.project_fields` 和 `fields` 中，不能加入 `editor`。`leading_columns` 声明展开视图新增的前置列；数组内的每个对象仅提供可见列的标量值，例如 `{instance_device: "DSP1", address: 50006}`。其余列继承模板，展开行按前置列自然排序，单表最多 100000 行。展开仅用于查看和复制，修改通过原模板完成；不改变总体视图或存储身份。列表读表时，通用引擎为脚本提供 `row.device_instances`，其中 `address` 已统一计算；原始图投影可能没有此显示上下文，脚本应在此时保留空补丁。

转发表可启用顶层 `instance_calculation: true`，复用同一 `behavior` 文件的 `instances` 操作。输入为 `context.rows = [{id, group_key, endpoint_key, protocol, base_address, devices}]`，其中 `base_address` 是已保存的模板 `address`；设备含稳定 `instance_index`，旧配置未指定时按组内配置顺序补充零起始序号。返回 `[{id, device_code, address}]`，须完整覆盖每个模板/设备组合一次，不得增加属性或借用 ID，最多 10000 个实例。脚本、JSON 参数和实例定义一起决定地址；Rust 检查整数、范围和覆盖，再用同一结果做地址重叠校验、界面显示、转发生成及派生采集输入。规则读取不回写数据库，错误阻止生成，预览与发布冻结脚本及参数。参见 `config/dc-ups/UPM/transmit.js`。

## 脚本接口

导出同步命名函数：

```js
export function behavior(context, parameters) {
  if (context.action === "normalize") {
    const values = {...context.fields};
    delete values.calibration_gain;
    if (Object.hasOwn(context.fields, "calibration_gain")) {
      values.metadata = {
        ...context.row.metadata,
        calibration_gain: Number(context.fields.calibration_gain)
      };
    }
    return {values};
  }
  if (context.action === "project") {
    return context.rows.map(row => {
      const gain = row.metadata.calibration_gain ?? parameters.default_gain;
      return {id: row.id, values: {
        calibration_gain: gain,
        calibrated_label: `${row.name} × ${gain}`
      }};
    });
  }
  if (context.action === "reconcile") {
    return context.rows.map(row => ({id: row.id, values: {}}));
  }
  if (context.action === "validate") {
    return context.rows.flatMap(row => {
      const gain = row.metadata.calibration_gain ?? parameters.default_gain;
      return Number.isInteger(gain) && gain >= 1 && gain <= 10 ? [] : [{
        id: row.id, level: "error", code: "calibration_gain",
        message: "校准系数必须是 1～10 的整数"
      }];
    });
  }
  throw new Error(`不支持的操作：${context.action}`);
}
```

| 操作 | 输入 | 返回值 |
| --- | --- | --- |
| `normalize` | `row` 当前记录、`fields` 本次提交、`source` 关联处理点、`operation` | `{values: {...}}`，规范化后的提交字段 |
| `project` | `rows` 本表记录、`sources` 本板卡处理点 | `[{id, values}]`，仅用于显示和编辑初值 |
| `reconcile` | `rows` 本表记录、`sources` 本板卡处理点 | `[{id, values}]`，仅更新 `owned_fields`、`linked_fields` |
| `validate` | `rows` 本表记录、`sources` 本板卡处理点 | `[{id, level, code, message}]`，没有问题时返回 `[]` |

`normalize` 返回的是完整提交补丁：先复制要保留的 `context.fields`，再移除自定义输入并转换为真实存储字段。它不是整条数据库记录。修改元数据时复制旧 `metadata`，避免删除 Excel 来源信息。

`project` 和 `reconcile` 必须恰好返回每条输入记录一次。`project` 必须明确返回每个 `editable_fields` 的当前值，空值使用 `null`；没有联动更新的 `reconcile` 可返回 `{id, values:{}}`。不能新增、遗漏、重复或借用其他表的 ID。转发、采集规则的 `sources` 包含处理表的显示投影，因此可使用处理表脚本提供的自定义字段。没有源记录的处理表操作不应假定 `source` 存在。

`project` 的 `rows` 按记录 ID 稳定排序，界面显示顺序不参与脚本输入。转发、采集的 `sources` 来自本板卡完整处理点表，包含尚未建立映射的点；单条编辑的 `source` 也先完成全表投影再选取关联点。依赖其他处理行的显示计算因此在读表、编辑和布局计算中使用同一范围。

处理表可以在 `project_fields` 和 `fields` 声明只读 `source_values`，返回 `{default_value, min_value, max_value}` 的原始来源值。通用校验据此识别导入时已经存在的符号值，以及默认值超出上下限的问题；原样保留时提示警告，用户新增的不合法值仍作为错误。DSP 的列号映射在 `process.js` 中读取不可编辑的 `metadata.source_cells.values`，Rust 不需要知道 I/J/K 列。也可使用导入时保留的 `metadata.original_ranges`。来源基线必须来自不可变的导入证据，不能使用当前编辑值伪造；`source_values` 不加入编辑字段或存入业务列。

`validate` 的 `level` 为 `error` 或 `warning`。错误阻止保存或生成；警告保留到结果中。`id` 引用本表行，整体问题可使用 `0`。脚本校验与 Rust 校验共同生效，脚本不能取消通用安全检查。

## 联动与计算

例如转发表声明 `owned_fields: ["upp_model"]`，便可在 `reconcile` 中根据 `sources` 的业务分类推导每条转发的模型号。该字段由规则管理，表单不应再提供独立输入。用户仍负责实际通信类型、精度等人工配置。

协议布局继续使用独立的 `calculation` 契约：负责转发的 `address`、`wire_length`，详情见 [点表计算规则](table-calculation.md)。只读派生采集表使用 `mapping` 契约展开来源设备，不再叠加 `behavior`，见 [upm-demo](upm-demo.md)。三者分别处理表行为、布局和派生映射，输出范围固定。

布局脚本每条输入的 `source` 包含处理表投影，`fields` 包含当前转发业务字段及扩展元数据。新增的 `calibration_gain` 等自定义字段可直接参与计算，无需再修改 Rust；显示顺序及旧地址、旧协议长度不作为计算输入。该扩展复用现有协议地址和长度约束，不开放任意协议编码。

一次完整的单条、批量或总体视图修改会完成规范化、联动、布局计算与来源同步，再进入权限、校验、冲突判断及历史事务。由源字段引起的其他表变化也计入权限和预览影响范围；不允许只保存其中一部分。

预览冻结 JSON 参数和脚本正文。预览后修改脚本，即使文件名相同，旧预览提交也会被拒绝。历史记录保存所有实际变动行的前后值及共同批次。正常读表只执行显示与检查，不写入数据库；更换规则后应先预览确认需要持久保存的变化。

修改 `reconcile` 算法或参数后，已保存的联动字段可能不符合新规则。后端报告 `behavior_stale` 并阻止生成和发布，读取不会自动保存。对相应表执行“重算表规则”，检查影响后提交；仅配置 `behavior.owned_fields` 的表也能重算，不要求另配布局 `calculation`。HTTP 对应 `POST /projects/:id/boards/:board/point-tables/:kind/preview`，请求包含当前 `revision`、`operation: "recalculate"` 和 `values: {}`，随后提交返回的预览。恢复旧规则同样需要检查与重算。

转发表布局只管理转发记录的偏移和长度。采集周期、采集地址及接收策略独立保留，修改采集设置不会套用转发表的布局结果。

## Excel 与文件夹导入

`workbook.json` 负责把 Excel 转换成规范的存储行：处理表直接映射通用字段和 `metadata`，不执行表单的 `normalize`。新自定义字段应映射到其真实元数据子键，而不是把界面虚拟字段名直接写入数据库。采集、转发导入会调用本表 `normalize`，其 `operation` 为 `"import"`；脚本应保留来源提供的地址、实际类型和精度，只补齐规则要求的值或报告不一致。

导入时处理点完整列表先执行 `project`，再按引用选出每条映射的 `source`，与普通读表使用相同的跨行投影范围。此时来源 ID 是本次解析按顺序分配的临时标识；落库后重新分配正式 ID，脚本不能把临时 ID 保存为数据库引用。

导入不会执行持久联动 `reconcile` 或布局重算 `calculation`。来源中的规则持有字段必须已经满足业务规则；不满足时导入回滚，应修正工作簿映射或明确的导入规范化逻辑后重新预览。这样保留 Excel 中实际定义的协议值，避免导入时悄悄重排布局。Dump 同样保留导入值并校验；无 Dump 的文件夹导入保留当前点记录，配置更新造成的规则过期通过后续显式重算解决。

## 执行边界

脚本不能改变记录 ID、项目、板卡、来源单元格或系统权限。引用字段只能来自用户明确提交，并由 Rust 验证范围。不能通过脚本跳过编辑租约、RLS、版本检查、历史或协议地址校验。

每次调用使用独立的受限 QuickJS 环境，没有文件、网络、数据库、环境变量、时钟、随机数及 npm 模块访问。只接受同步 JSON 数据；拒绝 Promise、非有限数字、额外属性、重复 ID 和未声明字段。每表最多 10000 行，脚本和参数各最多 32 KiB，输入和输出各最多 16 MiB；共用运行时还限制内存、栈和执行时间。异常或超限使本次修改回滚。

当前扩展目标是复用已有数据模型、协议能力与控件。增加新项目、新字段、分类、显示和同表/关联源规则可通过 JSON 与 JS 完成；引入新的协议编码、存储关系、控件类型或系统权限能力，仍需扩展通用引擎。此契约不向项目脚本开放任意 SQL 或任意网络请求。

集成验收示例见 `tests/table-behavior.mjs`：陌生名称板卡仅通过 JSON 和 JS 定义校准字段、采集策略、转发模型联动和依赖新字段的地址计算，并检查预览回滚、历史、脚本冻结、过期规则显式重算、采集设置独立保存和非法输出拒绝。运行 `node tests/integration.mjs --upm-address` 验证采集 Base 地址持久化、跨表权限与并发、实例公式修改及显示/生成/派生采集的一致性。
