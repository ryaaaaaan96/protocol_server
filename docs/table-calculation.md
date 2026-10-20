# 点表计算规则

DSP 当前使用 Rust 内置 `builtin` 引擎，修改 `transmit.json` 的 JSON 参数即可调整计算，无需 JS 或重新编译后端。UPM 保留 Excel 导入地址，暂不自动计算。

## JSON 内置规则

```json
{
  "calculation": {
    "engine": "builtin",
    "parameters": {
      "header_bytes": 6,
      "type_bytes": {"U8": 1, "U16": 2, "S16": 2, "U32": 4, "S32": 4, "F32": 4},
      "group_by": ["endpoint_key", "upp_model"],
      "sort_by": [{"field": "upp_model"}, {"field": "upload_level", "descending": true}, {"field": "source_order"}],
      "fixed_offset_key": "name",
      "fixed_offsets": {}
    }
  }
}
```

按 `sort_by` 排序，每个 `group_by` 分组独立累计字节数。普通地址为 `header_bytes + 前面各行字节数`，固定地址行仍参与累计。`STRING` 取内部总字节数，其他类型读取 `type_bytes`。分组、排序和固定地址键可选 `id`、`process_point_id`、`source_order`、`endpoint_key`、`upp_model`、`upload_level`、`category`、`name`、`variable_name`。地址规则当前按 UPP 字节计数；Modbus 保留手动配置。

实际 DSP 配置还包含六个 Excel 固定偏移，见 `config/dc-ups/DSP/transmit.json`。参数和计算结果仍通过预览、地址冲突检查、权限与历史事务；读取配置不会自动改写数据库。修改规则后点击“重算协议布局”预览并保存。内置规则最多 10000 条输入，参数最多 32 KiB。

## 兼容 JavaScript 规则

已有项目仍可使用 `javascript` 和板卡目录内的 `script_file`。新板卡复用内置能力时只需要 JSON。以下说明适用于可选脚本模式。

## 配置与操作

```json
{
  "calculation": {
    "engine": "javascript",
    "script_file": "transmit.js",
    "parameters": { "header_bytes": 6 }
  }
}
```

对应 `transmit.js`：

```js
export default function calculate(points, parameters) {
  let offset = parameters.header_bytes;
  return points.map(point => {
    const row = { id: point.id, address: offset, wire_length: point.byte_length };
    offset += row.wire_length;
    return row;
  });
}
```

以上仅演示输入输出；原脚本示例还处理端点/模型分组、上传等级、协议类型和固定地址，请参考 `config/dc-ups/DSP/transmit.js`，不要用简单示例替换完整协议规则。

路径相对于所属表格 JSON 的目录，必须指向板卡目录内的 `.js` 普通文件；不能使用绝对路径、`..` 或链接到其他目录。项目文件夹导入、导出会携带 JS 文件。缺失文件、语法错误或非法路径会阻止配置加载。

1. 通过 SSH 修改所属板卡的 JS 脚本或 JSON 参数。
2. 刷新转发表，点击“重算协议布局”。服务端读取最新规则并预览影响总数及前 200 条明细，此时不修改点数据。
3. 确认预览后保存。计算结果、项目版本及历史在同一事务提交，失败则全部回滚。

普通新增、修改、删除及批量新增/修改也自动计算整表，再进入现有预览和保存流程。启用脚本后，`address`、`wire_length` 不得出现在 `editor` 或手动提交的数据中；可继续显示对应只读列。界面显示顺序与计算顺序独立。

配置加载、读表及导入本身保留现有/导入的点值，不自动重排数据库。当前布局与脚本不同会阻止生成和发布，需要预览保存后恢复。无需新增表或数据库迁移。

## 输入与输出契约

输入变量 `points` 只包含当前项目、当前板卡的转发映射。每条包含：

| 字段 | 含义 |
| --- | --- |
| `id`、`process_point_id` | 转发及内部点的固定记录 ID |
| `endpoint_key`、`upp_model` | 输出接口与已经推导的模型号 |
| `wire_type`、`scale` | 当前配置的实际通信类型及系数 |
| `name`、`variable_name` | 内部数据名称与原拼写变量名 |
| `internal_type`、`element_count`、`byte_length` | 内部类型、元素数、总字节数 |
| `upload_level`、`category` | 当前上传等级与分类 |
| `source_order` | 来源 Excel 行号；新点使用内部记录 ID |

`parameters` 是本表配置的参数对象。脚本可以在内部定义函数、排序、循环和跨行累计。输入不含界面 `display_order` 或上次计算的偏移/长度，避免反复计算产生累积漂移；默认按模型升序、上传等级降序、来源顺序及固定 ID 排列，同端点同模型独立累计。

返回值必须是同步数组，恰好包含每条转发一次，每项仅允许：

```json
{ "id": 123, "address": 6, "wire_length": 4 }
```

后端拒绝额外字段、重复/遗漏/外部 ID、非整数字节数、非法类型长度、越界和同端点同模型地址重叠。脚本不能增删记录、修改通信类型或系数、权限、型号与历史。修改脚本契约以外的数据范围仍需后端开发。

## 默认 DSP 规则与历史

标量按通信类型取字节数，`STRING` 取内部总字节数；默认类型合法组合与 Excel E 列一致。普通偏移为 `6 + 同端点同模型前面各行长度之和`。六个名称按原 Excel 固定：固件版本号版本 48、机器型号 8、机器版本号 24、序列号 62、机器型号编码 94、设备类型编码 96。固定地址行也参与累计。修改这些名称时需同步检查 `fixed_offsets`，它按名称匹配。

脚本不会根据上传等级自动增删转发映射；等级仅参与排序。多个转发可以引用同一个内部点；固定地址例外不能重复占用同一模型的地址。

预览保存完整参数、文件引用和脚本正文，提交时重新读取并比较。只修改 JS 文件也会使旧预览失效；他人新增映射导致联动范围扩大时也需重新预览。合法的不相关字段修改仍可合并。点历史保存所有受影响行的前后值和共同批次，审计保存使用的计算规则。每次计算在新的执行环境中运行，脚本中的全局变量不跨用户或请求共享。

## JavaScript 与 TypeScript

脚本使用 JavaScript ES 模块，必须默认导出同步 `calculate(points, parameters)` 函数。可以在同一文件内拆分多个辅助函数；当前不加载其他模块，不执行网络请求、异步任务或 npm 包。

当前服务端直接执行 `.js`，不接受 TS 类型语法。可以使用 JSDoc 添加类型提示；若用 TypeScript 编写，应先编译成 JS，再让 JSON 指向编译后的文件。现有项目不需要增加这一步。

## 执行限制

脚本不能访问文件、网络、数据库、环境变量、时钟或随机数。服务器限制每张表 10000 条输入、脚本和参数各 32 KiB、64 MiB 引擎堆内存、512 KiB 调用栈、2000 次引擎中断检查及 2 秒执行期限。中断次数不是 JavaScript 语句数；执行期限在引擎检查点触发。超限、语法或执行错误均不保存，JSON 不能关闭限制。执行控制来自 [rquickjs Runtime](https://docs.rs/rquickjs/0.14.0/rquickjs/runtime/struct.Runtime.html)。

构建后端需要 Rust 1.87 或更新版本，以及 C 编译器来编译嵌入引擎；`scripts/check-env.sh` 会检查 Rust 版本、`cc` 和引用的 JS 文件是否齐全。Ubuntu/WSL 使用 `build-essential`，macOS 使用 Xcode Command Line Tools。
