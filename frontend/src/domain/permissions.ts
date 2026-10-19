import type { Row } from "../api";
import type { PointKind, PointTableData } from "./pointTables";

export type EditGrant = {
  model_id: number;
  scope: "board" | "internal" | "protocol";
  contract_id?: number;
};
export type ProjectPermissions = {
  role: "admin" | "engineer" | "viewer";
  edit_scope: "all" | "scoped";
  grants: EditGrant[];
  can_edit: boolean;
  can_manage_project: boolean;
  catalog: Array<{
    model_id: number;
    model_name: string;
    model_code: string;
    protocols: Array<{ contract_id: number; name: string; code: string; protocol: string; transports: string[] }>;
  }>;
};

// These checks explain and constrain the UI. The backend checks the full impact
// of the change again in the preview and commit transactions.
export function allowsScope(permissions: ProjectPermissions | null, scope: EditGrant): boolean {
  if (!permissions?.can_edit) return false;
  if (permissions.can_manage_project) return true;
  return permissions.grants.some(grant => grant.model_id === scope.model_id && (
    grant.scope === "board" || (grant.scope === scope.scope && (
      scope.scope !== "protocol" || grant.contract_id === scope.contract_id
    ))
  ));
}

export function allowsBoard(permissions: ProjectPermissions | null, modelId: number): boolean {
  return !!permissions?.can_edit && (permissions.can_manage_project || permissions.grants.some(grant => grant.model_id === modelId));
}

export function allowsPoint(permissions: ProjectPermissions | null, modelId: number, kind: PointKind, data: PointTableData, row?: Row | null): boolean {
  if (kind === "process") return allowsScope(permissions, { model_id: modelId, scope: "internal" });
  if (data.storage === "native" && allowsScope(permissions, { model_id: modelId, scope: "board" })) return true;
  const endpointId = row?.edit_values?.endpoint_id ?? row?.endpoint_id;
  const endpoints = (data.options.endpoints || []).filter(endpoint =>
    endpoint.role === (kind === "collect" ? "client" : "server") &&
    (data.storage === "native" || row == null || endpoint.id === endpointId));
  return endpoints.some(endpoint => allowsScope(permissions, { model_id: modelId, scope: "protocol", contract_id: endpoint.contract_id }));
}

export function allowsEntity(permissions: ProjectPermissions | null, graph: Row, entity: string, row?: Row | null): boolean {
  if (!permissions?.can_edit) return false;
  if (permissions.can_manage_project) return true;
  if (!row) return false;
  const records = (table: string): Row[] => graph[table] || [];
  const find = (table: string, id: unknown) => records(table).find(item => item.id === id);
  const internal = (modelId?: number) => modelId != null && allowsScope(permissions, { model_id: modelId, scope: "internal" });
  const endpoint = (id: unknown) => {
    const item = find("endpoints", id);
    return !!item && allowsScope(permissions, { model_id: item.model_id, scope: "protocol", contract_id: item.contract_id });
  };
  const signal = (id: unknown) => internal(find("signal_groups", find("signals", id)?.group_id)?.model_id);
  const contract = (id: unknown) => {
    const endpoints = records("endpoints").filter(item => item.contract_id === id);
    return endpoints.length > 0 && endpoints.every(item => endpoint(item.id));
  };
  switch (entity) {
    case "board_models": return allowsScope(permissions, { model_id: row.id, scope: "board" });
    case "boards": return allowsScope(permissions, { model_id: row.model_id, scope: "board" });
    case "signal_groups":
    case "device_contexts": return internal(row.model_id);
    case "signals": return internal(find("signal_groups", row.group_id)?.model_id);
    case "signal_ranges": return signal(row.signal_id);
    case "protocol_contracts": return contract(row.id);
    case "protocol_fields": return contract(row.contract_id);
    case "endpoints": return allowsScope(permissions, { model_id: row.model_id, scope: "protocol", contract_id: row.contract_id });
    case "signal_bindings": return endpoint(row.endpoint_id);
    case "board_links":
    case "passthrough_routes": return endpoint(row.client_endpoint_id) && endpoint(row.server_endpoint_id);
    case "data_items": {
      const signals = records("signals").filter(item => item.data_item_id === row.id);
      const fields = records("protocol_fields").filter(item => item.data_item_id === row.id);
      return signals.length + fields.length > 0 && signals.every(item => signal(item.id)) && fields.every(item => contract(item.contract_id));
    }
    case "platform_signals": {
      const signals = records("signals").filter(item => item.sig_symbol === row.symbol);
      return signals.length > 0 && signals.every(item => signal(item.id));
    }
    default: return false;
  }
}
