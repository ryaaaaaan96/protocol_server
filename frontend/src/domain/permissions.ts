import type { Row } from "../api";
import type { PointKind, PointTableData } from "./pointTables";

export type EditGrant = {
  board_key: string;
  scope: "board" | "internal" | "protocol";
  endpoint_key?: string;
};
export type ProjectPermissions = {
  role: "admin" | "engineer" | "viewer";
  edit_scope: "all" | "scoped";
  grants: EditGrant[];
  can_edit: boolean;
  can_manage_project: boolean;
  catalog: Array<{
    board_key: string;
    board_name: string;
    endpoints: Array<{ endpoint_key: string; name: string; protocol: string }>;
  }>;
};

// The backend checks the complete change again during preview and commit.
export function allowsScope(permissions: ProjectPermissions | null, scope: EditGrant): boolean {
  if (!permissions?.can_edit) return false;
  if (permissions.can_manage_project) return true;
  return permissions.grants.some(grant => grant.board_key === scope.board_key && (
    grant.scope === "board" || (grant.scope === scope.scope && (
      scope.scope !== "protocol" || grant.endpoint_key === scope.endpoint_key
    ))
  ));
}

export function allowsBoard(permissions: ProjectPermissions | null, boardKey: string): boolean {
  return !!permissions?.can_edit && (permissions.can_manage_project || permissions.grants.some(grant => grant.board_key === boardKey));
}

export function allowsPoint(permissions: ProjectPermissions | null, boardKey: string, kind: PointKind, data: PointTableData, row?: Row | null): boolean {
  if (kind === "process") return allowsScope(permissions, { board_key: boardKey, scope: "internal" });
  if (allowsScope(permissions, { board_key: boardKey, scope: "board" })) return true;
  const endpointKey = row?.edit_values?.endpoint_key ?? row?.endpoint_key;
  if (row != null) return typeof endpointKey === "string" && allowsScope(permissions, {
    board_key: boardKey, scope: "protocol", endpoint_key: endpointKey,
  });
  return (data.options.endpoints || []).some(endpoint => allowsScope(permissions, {
    board_key: boardKey, scope: "protocol", endpoint_key: endpoint.endpoint_key ?? endpoint.code,
  }));
}
