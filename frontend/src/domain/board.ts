import type { Row } from "../api";

export type Sheet = {
  key: string;
  label: string;
  entity: string;
  role?: "client" | "server";
  view?: string;
  columns?: string[];
};
export const boardSheets: Sheet[] = [
  { key: "signals", label: "内部信号表", entity: "signals" },
  {
    key: "collect",
    label: "采集表",
    entity: "signal_bindings",
    role: "client",
  },
  {
    key: "transmit",
    label: "转发表",
    entity: "signal_bindings",
    role: "server",
  },
  {
    key: "ranges",
    label: "范围表 · range",
    entity: "signal_ranges",
    columns: [
      "signal_name",
      "resolved_sig_id",
      "default_value",
      "min_value",
      "max_value",
      "boot_restore",
      "manual_restore",
    ],
  },
  { key: "fields", label: "协议字段", entity: "protocol_fields" },
  { key: "data", label: "数据定义", entity: "data_items" },
  { key: "routes", label: "透传路由", entity: "passthrough_routes" },
  {
    key: "expansion",
    label: "透传地址",
    entity: "v_passthrough_fields",
    columns: [
      "route_name",
      "name",
      "register_address",
      "register_length",
      "upp_model",
      "upp_offset",
    ],
  },
  {
    key: "links",
    label: "板间协议",
    entity: "type_connections",
    columns: ["name", "quantity", "protocol", "transport"],
  },
  { key: "endpoints", label: "协议端点", entity: "endpoints" },
  { key: "contexts", label: "逻辑设备", entity: "device_contexts" },
  { key: "groups", label: "信号组", entity: "signal_groups" },
];
export const projectSheets: Sheet[] = [
  { key: "models", label: "板卡模板", entity: "board_models" },
  { key: "contracts", label: "共享协议", entity: "protocol_contracts" },
  { key: "data", label: "共享数据目录", entity: "data_items" },
  { key: "symbols", label: "公共 sigID 符号", entity: "platform_signals" },
  {
    key: "sources",
    label: "工作簿来源",
    entity: "source_records",
    columns: ["sheet", "row_number", "classification"],
  },
];
export const rows = (g: Row, table: string): Row[] => g[table] || [];
export function boardScope(g: Row, board: Row) {
  const modelId = board.model_id;
  const groups = rows(g, "signal_groups").filter((r) => r.model_id === modelId);
  const signals = rows(g, "v_signals").filter((r) => r.model_id === modelId);
  const endpoints = rows(g, "endpoints").filter((r) => r.model_id === modelId);
  const contracts = new Set(endpoints.map((r) => r.contract_id));
  const fields = rows(g, "protocol_fields").filter((r) =>
    contracts.has(r.contract_id),
  );
  const dataIds = new Set([
    ...signals.map((r) => r.data_item_id),
    ...fields.map((r) => r.data_item_id),
  ]);
  return { groups, signals, endpoints, contracts, fields, dataIds };
}
export function belongsToBoard(
  g: Row,
  board: Row,
  entity: string,
  r: Row,
): boolean {
  const scope = boardScope(g, board);
  switch (entity) {
    case "boards":
      return r.id === board.id;
    case "board_models":
      return r.id === board.model_id;
    case "signals":
      return scope.groups.some((group) => group.id === r.group_id);
    case "signal_ranges":
      return scope.signals.some((s) => s.id === r.signal_id);
    case "signal_bindings":
      return scope.endpoints.some((e) => e.id === r.endpoint_id);
    case "protocol_fields":
    case "protocol_contracts":
      return scope.contracts.has(
        entity === "protocol_fields" ? r.contract_id : r.id,
      );
    case "data_items":
      return scope.dataIds.has(r.id);
    case "passthrough_routes":
      return scope.endpoints.some((e) => e.id === r.server_endpoint_id);
    case "board_links":
      return r.client_board_id === board.id || r.server_board_id === board.id;
    default:
      return r.model_id === board.model_id;
  }
}
export function scopedRows(
  g: Row,
  board: Row | undefined,
  entity: string,
  records: Row[],
): Row[] {
  if (!board) return records;
  // Compute membership once instead of rebuilding sets for every table row.
  const scope = boardScope(g, board),
    groups = new Set(scope.groups.map((r) => r.id)),
    signals = new Set(scope.signals.map((r) => r.id)),
    endpoints = new Set(scope.endpoints.map((r) => r.id));
  return records.filter((r) => {
    switch (entity) {
      case "boards":
        return r.id === board.id;
      case "signals":
        return groups.has(r.group_id);
      case "signal_ranges":
        return signals.has(r.signal_id);
      case "signal_bindings":
        return endpoints.has(r.endpoint_id);
      case "protocol_fields":
        return scope.contracts.has(r.contract_id);
      case "data_items":
        return scope.dataIds.has(r.id);
      case "passthrough_routes":
        return endpoints.has(r.server_endpoint_id);
      case "board_links":
        return r.client_board_id === board.id || r.server_board_id === board.id;
      default:
        return r.model_id === board.model_id;
    }
  });
}

// Constrain edit choices to the selected board and to the selected parent relation.
// The backend still enforces project ownership and all relationship constraints.
export function referenceOptions(
  g: Row,
  entity: string,
  key: string,
  table: string,
  values: Row,
  board?: Row,
  role?: string,
): Row[] {
  const all = rows(g, table);
  const endpoint = (id: unknown) =>
    rows(g, "endpoints").find((e) => e.id === id);
  const modelForBoard = (id: unknown) =>
    rows(g, "boards").find((b) => b.id === id)?.model_id;
  const activeModel = board?.model_id ?? values.model_id;
  const protocol = (id: unknown) =>
    rows(g, "protocol_contracts").find((c) => c.id === id)?.protocol;
  if (key === "model_id" && board && entity !== "boards")
    return all.filter((r) => r.id === board.model_id);
  if (key === "group_id")
    return all.filter((r) => !activeModel || r.model_id === activeModel);
  if (key === "endpoint_id")
    return all.filter(
      (r) =>
        (!activeModel || r.model_id === activeModel) &&
        (!role || r.role === role),
    );
  if (key === "client_endpoint_id" || key === "server_endpoint_id") {
    const side = key.startsWith("client") ? "client" : "server";
    const owner =
      entity === "board_links"
        ? modelForBoard(values[`${side}_board_id`])
        : activeModel;
    return all.filter(
      (r) =>
        owner &&
        r.model_id === owner &&
        r.role === side &&
        (entity !== "passthrough_routes" ||
          protocol(r.contract_id) === (side === "client" ? "UPP" : "MODBUS")),
    );
  }
  if (key === "client_context_id") {
    const owner = modelForBoard(values.client_board_id);
    return all.filter((r) => owner && r.model_id === owner);
  }
  if (key === "context_id") {
    const owner =
      endpoint(values.endpoint_id ?? values.client_endpoint_id)?.model_id ??
      activeModel;
    return all.filter((r) => owner && r.model_id === owner);
  }
  if (key === "field_id") {
    const ep = endpoint(values.endpoint_id);
    return ep ? all.filter((r) => r.contract_id === ep.contract_id) : [];
  }
  if (key === "signal_id") {
    const context = rows(g, "device_contexts").find(
      (r) => r.id === values.context_id,
    );
    const groups = rows(g, "signal_groups")
      .filter((r) => !activeModel || r.model_id === activeModel)
      .map((r) => r.id);
    return all.filter(
      (r) =>
        groups.includes(r.group_id) &&
        (!context || r.group_id === context.group_id),
    );
  }
  if (key === "contract_id" && entity === "protocol_fields" && board) {
    const contracts = boardScope(g, board).contracts;
    return all.filter((r) => contracts.has(r.id));
  }
  if (key === "client_board_id")
    return all.filter((r) => r.id !== values.server_board_id);
  if (key === "server_board_id")
    return all.filter((r) => r.id !== values.client_board_id);
  return all;
}
