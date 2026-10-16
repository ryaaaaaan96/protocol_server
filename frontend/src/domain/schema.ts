export type FieldSpec = {
  key: string;
  label: string;
  type?: "number" | "boolean" | "text";
  options?: string[];
  ref?: string;
  nullable?: boolean;
  default?: unknown;
  hint?: string;
};
export type EntitySpec = {
  label: string;
  fields: FieldSpec[];
  columns: string[];
  view?: string;
};
const f = (
  key: string,
  label: string,
  extra: Partial<FieldSpec> = {},
): FieldSpec => ({ key, label, ...extra });
const ref = (key: string, label: string, table: string, nullable = false) =>
  f(key, label, { ref: table, nullable });
const name = f("name", "名称"),
  code = f("code", "代码标识", {
    hint: "使用英文字母、数字和下划线，以字母或下划线开头。",
  });
const model = ref("model_id", "板卡模板", "board_models");
const data = ref("data_item_id", "共享数据定义", "data_items");
const types = ["U8", "U16", "S16", "U32", "S32", "F32", "STRING"];
export const specs: Record<string, EntitySpec> = {
  board_models: {
    label: "板卡模板",
    fields: [
      name,
      code,
      f("description", "说明"),
      f("firmware_profile", "生成目标", {
        options: ["contract", "aidc"],
        default: "contract",
        hint: "contract 生成协议契约；aidc 额外生成 AIDC C 配置。",
      }),
    ],
    columns: ["name", "code", "firmware_profile"],
  },
  boards: {
    label: "板卡实例",
    fields: [name, code, model],
    columns: ["name", "code", "model_id"],
  },
  data_items: {
    label: "共享数据定义",
    fields: [
      name,
      f("data_type", "数据类型", { options: types, default: "U16" }),
      f("byte_length", "数据长度 / 字节", {
        type: "number",
        default: 2,
        hint: "使用此定义的信号和自动协议布局将一起变化。",
      }),
      f("unit", "单位"),
      f("default_value", "默认值"),
      f("min_value", "下限"),
      f("max_value", "上限"),
      f("notes", "备注"),
    ],
    columns: [
      "name",
      "data_type",
      "byte_length",
      "unit",
      "source_sheet",
      "source_row",
    ],
  },
  signal_groups: {
    label: "点表分组",
    fields: [name, code, model],
    columns: ["name", "code", "model_id"],
  },
  signals: {
    label: "内部信号",
    view: "v_signals",
    fields: [
      name,
      ref("group_id", "点表分组", "signal_groups"),
      data,
      f("enum_name", "枚举名"),
      f("sig_id", "数字 sigID", {
        type: "number",
        nullable: true,
        hint: "作用域为点表分组。数字与公共符号二选一；修改不会改变对端板卡的 sigID。",
      }),
      f("sig_symbol", "公共 sigID 符号", { nullable: true }),
      f("internal_type", "内部类型覆盖", {
        options: types,
        nullable: true,
        hint: "例如源变量为 F32，ARM 代理使用 S32；留空继承共享定义。",
      }),
      f("flags", "处理标志", { default: "0" }),
      f("callback", "回调函数", { default: "NULL" }),
      f("process_enabled", "加入处理表", { type: "boolean", default: true }),
    ],
    columns: [
      "name",
      "group_name",
      "resolved_sig_id",
      "enum_name",
      "data_type",
      "byte_length",
      "process_enabled",
    ],
  },
  signal_ranges: {
    label: "范围与恢复策略",
    fields: [
      ref("signal_id", "内部信号", "signals"),
      f("default_value", "默认值覆盖", {
        nullable: true,
        hint: "留空继承共享数据定义。",
      }),
      f("min_value", "下限覆盖", { nullable: true }),
      f("max_value", "上限覆盖", { nullable: true }),
      f("boot_restore", "上电恢复默认值", { type: "boolean", default: false }),
      f("manual_restore", "允许手动恢复默认值", {
        type: "boolean",
        default: false,
      }),
    ],
    columns: [
      "signal_id",
      "default_value",
      "min_value",
      "max_value",
      "boot_restore",
      "manual_restore",
    ],
  },
  device_contexts: {
    label: "逻辑设备上下文",
    fields: [
      name,
      code,
      model,
      ref("group_id", "共享点表分组", "signal_groups", true),
      f("dev_id", "固件 dev_id", { type: "number", default: 247 }),
      f("kind", "设备角色", {
        options: ["local", "proxy", "virtual"],
        default: "local",
      }),
    ],
    columns: ["name", "code", "model_id", "dev_id", "kind", "group_id"],
  },
  protocol_contracts: {
    label: "协议契约",
    fields: [
      name,
      code,
      f("protocol", "协议", { options: ["MODBUS", "UPP"], default: "UPP" }),
      f("description", "说明"),
    ],
    columns: ["name", "protocol", "code"],
  },
  protocol_fields: {
    label: "协议字段",
    view: "v_protocol_fields",
    fields: [
      name,
      ref("contract_id", "协议契约", "protocol_contracts"),
      data,
      f("ordinal", "排列顺序", { type: "number", default: 0 }),
      f("access", "协议读写权限", {
        options: ["RO", "RW", "WO"],
        default: "RO",
      }),
      f("address_mode", "地址规则", {
        options: ["auto", "manual"],
        default: "auto",
        hint: "自动地址从当前模型/寄存器区的前一手动锚点累计。",
      }),
      f("address", "手动地址 / 偏移", { type: "number", nullable: true }),
      f("model", "UPP 模型号", { type: "number", default: 0 }),
      f("register_type", "Modbus 寄存器区", {
        options: ["3", "4"],
        type: "number",
        default: 4,
        hint: "3 = 保持寄存器；4 = 输入寄存器。",
      }),
      f("wire_type", "协议类型覆盖", { options: types, nullable: true }),
      f("wire_length", "协议长度覆盖 / 字节", {
        type: "number",
        nullable: true,
        hint: "留空跟随共享定义；固定覆盖与内部信号不一致时会阻止提交。",
      }),
      f("scale", "协议转换系数", { type: "number", default: 1 }),
      f("byte_order", "字节序编号", { type: "number", default: 0 }),
    ],
    columns: [
      "name",
      "contract_name",
      "model",
      "effective_address",
      "effective_length",
      "effective_type",
      "access",
      "address_mode",
    ],
  },
  endpoints: {
    label: "协议端点",
    fields: [
      name,
      code,
      model,
      ref("contract_id", "协议契约", "protocol_contracts"),
      f("role", "协议角色", {
        options: ["client", "server"],
        default: "client",
      }),
      f("transport", "传输方式", {
        options: ["CAN", "CANFD", "RS485", "TCP", "UNSPECIFIED"],
        default: "UNSPECIFIED",
      }),
      f("port", "固件端口标识", { hint: "例如 CAN_PORT1 或 UART_PORT1。" }),
      f("enabled", "启用", { type: "boolean", default: true }),
    ],
    columns: [
      "name",
      "model_id",
      "contract_id",
      "role",
      "transport",
      "port",
      "enabled",
    ],
  },
  signal_bindings: {
    label: "采集 / 转发绑定",
    view: "v_bindings",
    fields: [
      ref("endpoint_id", "协议端点", "endpoints"),
      ref("context_id", "逻辑设备", "device_contexts"),
      ref("field_id", "协议字段", "protocol_fields"),
      ref("signal_id", "本地内部信号", "signals"),
      f("poll_interval", "轮询间隔", { type: "number", default: 0 }),
      f("set_priority", "设置优先级", { type: "number", default: 0 }),
      f("scan_priority", "轮询优先级", { type: "number", default: 0 }),
    ],
    columns: [
      "endpoint_name",
      "context_code",
      "signal_name",
      "resolved_sig_id",
      "field_name",
      "effective_address",
      "effective_length",
    ],
  },
  board_links: {
    label: "板卡协议连接",
    view: "v_topology_links",
    fields: [
      name,
      ref("client_board_id", "采集方板卡实例", "boards"),
      ref("client_endpoint_id", "采集方端点", "endpoints"),
      ref("client_context_id", "采集方设备上下文", "device_contexts"),
      ref("server_board_id", "服务方板卡实例", "boards"),
      ref("server_endpoint_id", "服务方端点", "endpoints"),
      f("remote_address", "对端通信地址", { type: "number", default: 1 }),
      f("dev_code", "UPP 设备编码", { type: "number", default: 0 }),
    ],
    columns: [
      "name",
      "client_board",
      "server_board",
      "protocol",
      "transport",
      "remote_address",
      "context_code",
    ],
  },
  passthrough_routes: {
    label: "地址段透传",
    fields: [
      name,
      ref("server_endpoint_id", "北向 Modbus 服务端", "endpoints"),
      ref("client_endpoint_id", "南向 UPP 采集端", "endpoints"),
      ref("context_id", "目标设备上下文", "device_contexts"),
      f("base_address", "窗口起始地址", { type: "number", default: 50000 }),
      f("end_address", "窗口结束地址", { type: "number", default: 50999 }),
      f("register_type", "寄存器区", {
        type: "number",
        options: ["3", "4"],
        default: 3,
      }),
      f("writable", "允许协议写入", { type: "boolean", default: false }),
      f("callback", "固件透传回调", {
        hint: "填写目标工程已有的地址段回调函数。",
      }),
    ],
    columns: [
      "name",
      "context_id",
      "base_address",
      "end_address",
      "writable",
      "callback",
    ],
  },
  platform_signals: {
    label: "公共 sigID 符号",
    fields: [
      f("symbol", "C 宏符号"),
      f("signal_id", "数字值", { type: "number", default: 1 }),
    ],
    columns: ["symbol", "signal_id"],
  },
};
export const labels: Record<string, string> = {
  id: "记录 ID",
  name: "名称",
  group_name: "所属点表分组",
  resolved_sig_id: "sigID",
  contract_name: "协议契约",
  effective_address: "计算地址",
  effective_length: "协议长度",
  effective_type: "协议类型",
  source_sheet: "来源表",
  source_row: "行号",
  endpoint_name: "协议端点",
  context_code: "设备上下文",
  signal_name: "内部信号",
  field_name: "协议字段",
  client_board: "采集方",
  server_board: "服务方",
  ...Object.fromEntries(
    Object.values(specs).flatMap((s) => s.fields.map((f) => [f.key, f.label])),
  ),
};
export function labelFor(
  g: Record<string, any>,
  table: string,
  id: unknown,
): string {
  const r = g[table]?.find((r: any) => r.id === Number(id));
  return r
    ? `${r.name || r.symbol || r.enum_name || "#" + r.id}${r.code ? " · " + r.code : ""}`
    : id == null
      ? "继承 / 未指定"
      : String(id);
}
