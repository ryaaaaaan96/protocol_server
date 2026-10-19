import type { Row } from "../api";

export type PointKind = "process" | "forward";
export type PointField = {
  label: string;
  column_label?: string;
  type?: "text" | "number" | "boolean";
  reference?: string;
  options?: string[];
  nullable?: boolean;
  default?: unknown;
  hint?: string;
};
export type PointDefinition = {
  label: string;
  description: string;
  columns: string[];
  editor: string[];
  fields: Record<string, PointField>;
  inline: Record<string, string>;
  ordering: { mode: "disabled" | "display" | "protocol"; group_by: string[] };
};
export type PointSchema = {
  boards: Record<string, Record<PointKind, PointDefinition>>;
  workspace: {
    boards: Record<
      string,
      { tables: string[]; labels?: Record<string, string> }
    >;
  };
};
export type PointTableData = {
  revision: number;
  board_key: string;
  kind: PointKind;
  storage?: "native";
  definition: PointDefinition;
  rows: Row[];
  options: Record<string, Row[]>;
};

function normalizedDataType(value: unknown): string | undefined {
  return typeof value === "string"
    ? value.trim().toUpperCase() || undefined
    : undefined;
}

export function isStringType(value: unknown): boolean {
  return normalizedDataType(value) === "STRING";
}

/** Resolve the internal type directly or through the selected process point. */
export function pointDataType(data: PointTableData, values: Row, fallbackRow?: Row): string | undefined {
  const original = { ...fallbackRow, ...fallbackRow?.edit_values };
  const current = { ...original, ...values };
  if (data.kind === "process") return normalizedDataType(current.internal_type ?? current.data_type);
  const signal = data.options.process_points?.find(item => item.id === current.process_point_id);
  if (signal) return normalizedDataType(signal.internal_type ?? signal.data_type);
  return current.process_point_id === original.process_point_id ? normalizedDataType(fallbackRow?.data_type) : undefined;
}

export function pointIsString(
  data: PointTableData,
  values: Row,
  fallbackRow?: Row,
): boolean {
  return isStringType(pointDataType(data, values, fallbackRow));
}

// All relations refer to stable record IDs. Captions and sigID are display values.
export function pointChoices(
  data: PointTableData,
  key: string,
  values: Row,
): Row[] {
  const field = data.definition.fields[key];
  if (!field) return [];
  const all = data.options[field.reference || ""] || [];
  if (field.reference === "native_groups")
    return all.map(group => ({ ...group, id: group.code }));
  if (field.reference === "endpoints")
    return all.map(endpoint => ({ ...endpoint, id: endpoint.endpoint_key ?? endpoint.code }));
  return all;
}
export function choiceLabel(row: Row): string {
  const detail =
    row.sig_id ??
    row.dev_id ??
    row.effective_address ??
    row.code ??
    row.data_type;
  return `${row.name}${detail == null ? "" : ` · ${detail}`}`;
}
export function pointText(value: unknown): string {
  return value == null
    ? "—"
    : typeof value === "boolean"
      ? value
        ? "是"
        : "否"
      : String(value);
}
