# UPM 点表

UPM 内部按 `LOCAL` 和 `DSP` 两个设备模板组织。LOCAL 是本地设备，没有采集表；DSP 共用一份点定义，设备实例与地址保存在 `config/dc-ups/project.json` 的 `point_groups[].devices` 中。

## 来源与关联

| 入口 | Excel 来源 | 存储与关联 |
| --- | --- | --- |
| 处理点表 / LOCAL | `UPM单板测点` | 161 个内部点；相同枚举的多地址行合并，保留源行位置 |
| 处理点表 / DSP | `UPM-DSP采集数据` | 445 个接收端内部点，与 DSP 板卡自己的内部点独立 |
| 采集点表 | `UPM-DSP采集数据` | 445 条采集映射引用 UPM 的 DSP 模板内部点 |
| 转发点表 · MODBUS | 上述两张表的 Modbus 地址列 | 531 条模板映射；一个内部点可以有多个地址 |
| 转发点表 · UPP | `CSU-UPM采集数据` | 只导入来源为 UPM 的 29 行；7 行 CSU 本地处理不导入 |

“总体视图”按当前设备模板并列展示处理数据与关联转发参数；一对多映射分别显示，未转发的处理点也保留。双击单元格编辑，共享处理字段同步展示，转发参数独立修改，经检查和预览后保存。采集参数仍在“采集点表”中编辑，LOCAL 不显示该表。列隐藏、冻结和顺序仅保存在本地浏览器。

内部点保存在 `points.process_points`，采集保存在 `points.collect_points`，两种对外映射共用 `points.transmit_points`，以端点区分。引用使用稳定记录 ID；sigID 属于各自接收设备，不能用 CSU 的 sigID 覆盖 UPM，也不能用 UPM 的 sigID 覆盖 DSP。

Excel sigID 的 `※` 表示未分配 UPM sigID、不上传 UPP；这些点仍可用于 DSP 采集及 Modbus 转发。数据库保留 `sig_id = NULL`，原标记存于 `metadata.source_sig_id`，不将特殊字符写入数字字段。`UPM/process.json` 的 `hidden_source_sig_ids: ["※"]` 控制处理点表及总体视图默认隐藏这些点；勾选“显示未分配 sigID 的点”可查看和编辑，填入有效 sigID 并保存后恢复默认显示。空白或其他缺失编号不会被一并隐藏。此配置只影响显示，不删除记录或改变协议生成。

## 设备与地址

### DSP 转发子集

`project.json` 中 UPM 的 `DSP_UPP` 采集端点通过 `subset_of` 声明来源：

```json
"subset_of": {"board_key": "DSP", "endpoint_key": "UPP_SERVICE"}
```

采集项须唯一匹配源转发的模型、地址、类型、字节数、精度和读写权限。当前 445 条均匹配，允许删除部分采集项；DSP 新增转发不会自动加入采集。新增/调整采集项时填写对应源转发参数。修改源转发或整表重算时，先按旧协议布局找到源记录，再跟随该记录 ID 同步已有采集项；布局变化不会误关联相邻地址的其他记录。

同步与源修改使用同一事务、预览、权限检查、版本合并和历史批次。需要同时拥有源转发和受影响采集项的编辑权限；采集周期、方式、优先级、接收字节序和 UPM 内部点信息保持独立。被采集引用的源记录不能直接删除，须先移除对应采集项。若同步后的类型/长度与 UPM 内部存储不兼容，整个修改被校验拒绝，不会改写内部点类型。

关系由 JSON 决定，不按 DSP/UPM 名称分支；无需新数据库表或迁移。服务器文件修改后通过“项目拓扑配置”读取并预览导入才应用到已有项目；无 Dump 的配置导入不重写点数据。Excel/Dump 导入保留导入值，最终子集不一致时拒绝；不在导入时静默同步其他板卡。

DSP1～DSP8 的通信编号 `dev_id` 分别为 1～8，稳定的 `instance_index` 分别为 0～7；两者独立配置：

```json
{"code":"DSP1","name":"DSP 设备 1","dev_id":1,"instance_index":0}
```

`UPM/transmit.json` 启用 `instance_calculation: true`，对应 `transmit.js` 的 `instances` 操作计算实际地址。参数位于 `behavior.parameters.modbus_layouts`：

```json
{"DSP":{"template_base":50000,"device_stride":1000},"LOCAL":{"template_base":0,"device_stride":0}}
```

JS 公式为 `instance_index * device_stride + template_base + base_address`。例如测点偏移为 6，DSP1 为 50006、DSP8 为 57006。`base_address` 在实例计算输入中取自已保存的转发 `address`；地址单位为寄存器，数量为 `ceil(wire_length / 2)`。UPP 的 `address` 仍是模型内字节偏移。未启用脚本的旧板卡继续兼容 `modbus_base + address`；UPM 的新规则不读取旧 `modbus_base`。

UPM 的 DSP 采集表新增可编辑“Base 地址”，保存于采集记录的 `metadata.base_address`，与 UPP 采集地址完全独立。未设置时显示关联 Modbus 转发的当前偏移，不在读取时回写数据库；多个不同偏移时显示空值。保存一个整数后，`transmit.js` 将同一内部点的 Modbus 转发偏移同步为该值，同事务检查地址、权限、并发及历史，UPP 地址、采集周期和优先级保留。清空该列解除联动，保留当前转发偏移；已联动的转发偏移应通过采集表修改。修改共享模板影响全部实例，采集与转发表不显示“设备地址”汇总列。

转发点表默认“按设备展开”，显示设备实例及实际协议地址；DSP1～DSP8 分别显示，LOCAL 仅显示本地实例。展开视图可搜索、分页、设置列与复制，不能单独编辑计算地址。切换“编辑共享模板”可编辑原始偏移及其他参数，或通过行菜单“共享模板详情”定位来源定义；有未保存修改时不能切换视图。总体视图仍按模板关联，不复制数据库记录。

展开由 `UPM/transmit.json` 的 `presentation.row_expansion` 声明。后台统一执行本表实例公式，显示、冲突校验、转发生成和 upm-demo 采集都使用该结果；`transmit.js` 的显示投影只选取设备名与实际地址。新增同类表仅需配置 JSON/JS，前端不计算地址。修改公式或参数不重写测点，越界或重叠会阻止生成；已生成产物包含当时的脚本与参数。

Modbus 优先采用备注中的 `0x03`（HOLDING）或 `0x04`（INPUT）；缺少备注时，本地 RO 使用 INPUT，其余使用 HOLDING。DSP 对外偏移采用 HOLDING。字节序初始为 0，可在 UPM 协议表中修改，部署前需核对固件。

## 导入与升级

已有项目首次增加 UPM，先停止旧 HTTP 服务，再执行：

```bash
cargo run -- migrate
cargo run -- import-board dc-ups UPM
./scripts/dev.sh
```

`import-board`（兼容旧 `import-upm`）验证并应用项目 JSON，仅在 UPM 无内部点时导入，重复运行保留已有点表，DSP 点数据不会被改写。与他人的编辑租约冲突时拒绝执行。新项目通过 `./scripts/create-project.sh dc-ups` 同时导入 DSP 与 UPM。

网页 Excel 导入按 JSON 列出已配置 workbook_import 的板卡；确认替换只影响所选板卡。文件夹导入不带 Dump 仍然不替换点表。新版 Dump 为 `(schema_version, migration_version) = (7, 4)`，包含三张业务表，兼容 `(6, 3)` 和旧 `(4, 1)`、`(5, 2)` 两表归档；旧归档导入后的采集表为空。

## 校验与来源差异

所有编辑使用现有预览、权限、版本合并、编辑租约和历史记录。采集记录也进入 `history.events`，类型为 `collect`。地址冲突按设备、协议和寄存器区检查；LOCAL 不允许添加采集映射。

- 根据用户确认，源 Excel `UPM单板测点!I138` 已由 U32 改为 U16，保留 2 字节、1 个寄存器。
- `※`、空值及占位 sigID `0` 不编造编号，保留原值来源并提示核实。
- 403 行上传数据的轮询参数保持为空；42 行按轮询方式导入。
- 既有范围倒置或符号值保留为来源警告；新增不合法修改会被拒绝。
- UPM 本轮保留 Excel 地址，不启用自动重排脚本，也不自动跟随 DSP 侧后续编辑。两端协议修改需分别核对。

生成产物包括 UPM 的三类点表 JSON 和按设备展开的转发地址 JSON，仍需固件侧验证。

UPM 工作簿映射位于 `config/dc-ups/UPM/workbook.json`，解析、校验及生成使用通用 Rust 引擎。新增同类板卡参见 [JSON 板卡配置](board-configuration.md)。
