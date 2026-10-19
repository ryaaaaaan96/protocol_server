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
  multiline?: boolean;
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

export function isDspSheet(data: PointTableData): boolean {
  return data.kind === "process" && data.definition.columns.includes("sheet_type") &&
    data.definition.columns.includes("variable_name");
}

export function sheetType(value: unknown): string | undefined {
  const type = normalizedDataType(value)?.replace(/^SYS_/, "");
  return type === "FLOAT" ? "F32" : type;
}

/** Resolve the internal type directly or through the selected process point. */
export function pointDataType(data: PointTableData, values: Row, fallbackRow?: Row): string | undefined {
  const original = { ...fallbackRow, ...fallbackRow?.edit_values };
  const current = { ...original, ...values };
  if (isDspSheet(data)) return sheetType(current.sheet_type);
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


const sheetMetadataColumns: Record<string, string> = {
  enum_table: "D", display_digits: "E", access: "M", ram: "N", flash: "O", eeprom: "P",
  calibration: "Q", structure: "R", cpu: "S", upload_level: "V", category: "W",
};

function sheetChangeValues(row: Row): Row {
  const projected = { ...row }, metadata = row.metadata || {};
  const source = (key: string, column: string) => Object.hasOwn(metadata, key)
    ? metadata[key] : metadata.source_cells?.values?.[column];
  if (Object.hasOwn(row, "enum_name")) {
    const variable = source("source_variable", "B");
    const normalized = typeof variable === "string" ? variable.trim()
      .replace(/([a-z0-9])([A-Z])/g, "$1_$2").replace(/([A-Z])([A-Z][a-z])/g, "$1_$2")
      .replace(/[^A-Za-z0-9]+/g, "_").replace(/^_|_$/g, "").toUpperCase() : "";
    projected.variable_name = normalized === row.enum_name && variable ? variable : row.enum_name;
    delete projected.enum_name;
  }
  if (Object.hasOwn(row, "internal_type")) {
    projected.sheet_type = `Sys_${row.internal_type}`;
    delete projected.internal_type;
  }
  for (const [key, column] of Object.entries(sheetMetadataColumns)) {
    const value = source(key, column);
    if (value !== undefined) projected[key] = key === "display_digits" ? Number(value) : value;
  }
  const remaining = Object.fromEntries(Object.entries(metadata).filter(([key]) =>
    key !== "source_cells" && key !== "source_variable" && !(key in sheetMetadataColumns)));
  if (Object.keys(remaining).length) projected.metadata = remaining;
  else delete projected.metadata;
  return projected;
}

/** Render raw impact records using the editable sheet names without mixing related transmit rows. */
export function pointChangeSummary(change: Row, fields?: Record<string, PointField>): string {
  let before = change.before || {}, after = change.after || {};
  const entity = change.entity;
  const process = entity === "process_points" || entity === "points.process_points" ||
    (!entity && [before, after].some(row => Object.hasOwn(row, "internal_type") &&
      Object.hasOwn(row, "enum_name") && !Object.hasOwn(row, "process_point_id") && !Object.hasOwn(row, "wire_type")));
  if (fields?.variable_name && fields.sheet_type && process) {
    before = sheetChangeValues(before);
    after = sheetChangeValues(after);
  }
  const text = (value: unknown) => value !== null && typeof value === "object"
    ? JSON.stringify(value) : pointText(value);
  const labels: Record<string, string> = { display_order: "显示顺序", ordinal: "协议排列", effective_address: "协议地址" };
  return Object.keys({ ...before, ...after })
    .filter(key => !["project_id", "raw_json"].includes(key) && JSON.stringify(before[key]) !== JSON.stringify(after[key]))
    .map(key => `${fields?.[key]?.column_label || fields?.[key]?.label || labels[key] || key}：${text(before[key])} → ${text(after[key])}`)
    .join("；");
}
