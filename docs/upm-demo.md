# upm-demo 演示采集设备

`config/dc-ups/upm-demo/` 定义一个只显示采集表的设备，拓扑代码为 `UPM_DEMO`，界面名称为 `upm-demo`。它是 UPM 的父板卡，通过 Modbus 采集 UPM；采集来源通过 `collect.json` 指向 UPM 的 `MODBUS_SERVICE`，不按拓扑父子关系推断来源。

CSU 与 upm-demo 都没有父板卡，分别在 `topology.roots` 中声明。UPM 同时有两个上级：`CSU → UPM` 保留原 Modbus / CANFD、UPP / CANFD 连接；`upm-demo → UPM` 使用 **Modbus / RS485**。两条连接引用同一组 24 个 UPM，不累加成 48 个；每个 UPM 下挂 8 个 DSP，DSP 总数仍为 192。CSU 与 upm-demo 之间没有连接。

## 配置与规则

- `project.json`：`point_storage: "derived"`、一个 Modbus 采集端点，workspace 只启用 `collect`。
- `collect.json`：列显示、来源、脚本引用及接收参数。
- `collect.js`：完整映射及地址展开公式。修改规则无需再增加板卡专用 Rust 代码。
- `process.json`、`transmit.json`：通用配置要求的占位定义，均未启用，不显示、不存储点数据。

```json
"mapping": {
  "engine": "javascript",
  "script_file": "collect.js",
  "source": {"board_key": "UPM", "endpoint_key": "MODBUS_SERVICE"},
  "endpoint_key": "UPM_MODBUS",
  "group_key": "LOCAL",
  "parameters": {"upm_dev_id": 1, "poll_interval": 1000, "byte_order": 0}
}
```

脚本使用 `export default function calculate(points, parameters)`。每条输入包含 `source_id`、模板寄存器地址、类型、字节数、寄存器区及源分组的 `devices`。每条输出只能包含 `source_id`、`device_code`、`address`、`dev_id`。本例公式为：

```js
address = point.address + device.modbus_base;
dev_id = parameters.upm_dev_id;
```

LOCAL 基址为 0；DSP1～DSP8 的基址为 50000～57000，间隔 1000，地址单位为 Modbus 寄存器。寄存器数量继承协议字节数，按 `ceil(wire_length / 2)` 得到。数据类型、读写权限、精度、名称等直接继承源记录，不允许脚本篡改。

当前完整数据为 **86 条 LOCAL + 445 × 8 条 DSP = 3646 条**。这些记录都读取同一个 UPM 从站；来源 DSP 设备的内部 `dev_id` 不作为 Modbus 从站号使用。默认从站号为 1，采集周期为 1000 毫秒；这是演示配置，实际值在 JSON 参数中修改。

## 使用方式

重启升级后的服务，在“项目拓扑配置”中重新读取项目文件、检查并导入拓扑，即可选择 `upm-demo`。之后修改 JS/JSON 并刷新即可更新派生表；源 UPM 点表修改保存后也会实时反映。派生表支持搜索、复制和本地列设置，数据在 UPM 源表编辑，接收参数在 JSON 编辑。

页面入口为 **DC-UPS → 板卡内部信息 → UPM_DEMO / upm-demo → 采集点表**；项目拓扑中与 CSU 并列，连接到同一个 UPM 节点。

如果文件中已有 `UPM_DEMO`，页面却没有该设备，检查是否尚未导入新拓扑。板卡列表读取项目库 `meta.project_state.topology_config` 中已应用的拓扑；修改磁盘 `project.json`、重启服务或刷新页面都不会自动应用拓扑变更。在“项目设置”页面点击“开始编辑”，再依次选择“项目拓扑配置 → 重新读取项目文件 → 检查项目配置 → 导入已检查的拓扑”。导入成功后刷新页面；此操作保留已有点记录，并记录项目版本和审计历史。

读取和生成不写数据库，不需要新表、迁移、Excel 导入或复制 UPM 内部点。生成包包含 `board_types/UPM_DEMO/collect.json`，其中冻结映射结果和脚本正文；已有发布保持不变。本功能生成采集配置，不发起 Modbus 网络轮询。

脚本与参数限 32 KiB，展开最多 10000 行，共用现有 QuickJS 的 64 MiB 内存、栈和时间限制，无宿主文件、网络和模块加载能力。每个源记录及其设备实例必须恰好出现一次；遗漏、重复、未知引用、非法从站号、地址越界或同一从站/寄存器区地址重叠都会拒绝生成。运行失败进入校验结果并阻止发布。
