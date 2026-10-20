import type { Row } from "../api";

export type PointKind = "process" | "collect" | "forward";
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
  protocols?: string[];
};
export type PointDefinition = {
  behavior?: Record<string, unknown> & { owned_fields?: string[]; linked_fields?: string[] };
  instance_calculation?: boolean;
  presentation?: {
    category_filter?: string;
    search_placeholder?: string;
    empty_text?: string;
    overview_hidden_fields?: string[];
    overview_leading_fields?: string[];
    computed_dependencies?: Record<string, string[]>;
    row_expansion?: { field: string; leading_columns: string[] };
    suggestion?: { reference: string; source_key: string; fields: Record<string, string>; description?: string };
  };
  mapping?: Record<string, unknown>;
  hidden_source_sig_ids?: string[];
  calculation?: { engine: "javascript" | "builtin"; script_file?: string; script?: string; parameters: Record<string, unknown> };
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
  storage?: "native" | "derived";
  derived?: boolean;
  definition: PointDefinition;
  rows: Row[];
  options: Record<string, Row[]>;
};

/** A source marker is informational; assigning a sigID enables the retained point. */
export function hiddenProcessPoint(definition: PointDefinition, row: Row): boolean {
  const marker = row.source_sig_id ?? row.metadata?.source_sig_id;
  return row.sig_id == null && typeof marker === "string" &&
    !!definition.hidden_source_sig_ids?.some(value => value.trim() === marker.trim());
}

function normalizedDataType(value: unknown): string | undefined {
  return typeof value === "string"
    ? value.trim().toUpperCase() || undefined
    : undefined;
}

export function isStringType(value: unknown): boolean {
  return normalizedDataType(value) === "STRING";
}

/** The server owns table formulas; the UI only consumes declared suggestion values. */
export function hasRecommendation(data: PointTableData): boolean {
  return !!data.definition.presentation?.suggestion;
}

export function hasRecalculation(definition: PointDefinition): boolean {
  return !!definition.calculation || !!definition.behavior?.owned_fields?.length || !!definition.behavior?.linked_fields?.length;
}

export function recommendationFields(data: PointTableData): string[] {
  return Object.keys(data.definition.presentation?.suggestion?.fields || {});
}

export function communicationRecommendation(data: PointTableData, values: Row, row?: Row): Row | undefined {
  const spec = data.definition.presentation?.suggestion;
  if (!spec) return undefined;
  const selected = Object.hasOwn(values, spec.source_key) ? values[spec.source_key] : row?.[spec.source_key];
  if (selected == null) return undefined;
  const current = { ...row, ...row?.edit_values, ...values };
  const source = pointChoices(data, spec.source_key, current).find(item => item.id === selected) ||
    (selected === row?.[spec.source_key] ? row : undefined);
  if (!source) return undefined;
  const entries = Object.entries(spec.fields).filter(([target]) => fieldApplies(data, target, current))
    .map(([target, key]) => [target, source[key]]);
  // A missing server value must never trigger a browser-side approximation.
  if (!entries.length || entries.some(([, value]) => value == null ||
    !["string", "number", "boolean"].includes(typeof value) ||
    (typeof value === "number" && !Number.isFinite(value)))) return undefined;
  return Object.fromEntries(entries);
}

export function communicationHint(data: PointTableData, values: Row, row?: Row): string {
  const description = data.definition.presentation?.suggestion?.description || "建议值由表格规则计算，可按实际通信配置调整。";
  const suggestion = communicationRecommendation(data, values, row);
  if (!suggestion) return `${description}选择来源记录后查看建议。`;
  const label = (key: string) => data.definition.fields[key]?.label || key;
  const recommended = Object.entries(suggestion).map(([key, value]) => `${label(key)} ${pointText(value)}`).join("，");
  const changed = Object.entries(suggestion).find(([key, value]) => data.definition.editor.includes(key) &&
    (values[key] ?? row?.[key]) != null && !Object.is(values[key] ?? row?.[key], value));
  return `${description}建议：${recommended}。${changed ? `当前 ${pointText(values[changed[0]] ?? row?.[changed[0]])} 偏离建议；保存时会校验关联和转换。` : ""}`;
}

export function communicationDiffers(data: PointTableData, values: Row, row?: Row): boolean {
  const suggestion = communicationRecommendation(data, values, row);
  return !!suggestion && Object.keys(suggestion).filter(key => data.definition.editor.includes(key))
    .some(key => !Object.is(Object.hasOwn(values, key) ? values[key] : row?.[key], suggestion[key]));
}

export function editableCommunicationRecommendation(data: PointTableData, values: Row, row?: Row): Row {
  return Object.fromEntries(Object.entries(communicationRecommendation(data, values, row) || {})
    .filter(([key]) => data.definition.editor.includes(key)));
}

/** Protocol-specific fields are declared by the project, not chosen by a fixed UI list. */
export function definitionForProtocol(definition: PointDefinition, protocol?: string): PointDefinition {
  if (!protocol) return definition;
  const allowed = (key: string) => !definition.fields[key]?.protocols || definition.fields[key].protocols!.includes(protocol);
  return { ...definition, columns: definition.columns.filter(allowed), editor: definition.editor.filter(allowed),
    inline: Object.fromEntries(Object.entries(definition.inline).filter(([column, field]) => allowed(column) && allowed(field))) };
}

export function fieldApplies(data: PointTableData, key: string, values: Row): boolean {
  const protocols = data.definition.fields[key]?.protocols;
  if (!protocols) return true;
  const endpoint = data.options.endpoints?.find(item => (item.endpoint_key ?? item.code) === values.endpoint_key);
  return !endpoint || protocols.includes(endpoint.protocol);
}

/** Resolve the internal type directly or through the selected process point. */
export function pointDataType(data: PointTableData, values: Row, fallbackRow?: Row): string | undefined {
  const original = { ...fallbackRow, ...fallbackRow?.edit_values };
  const current = { ...original, ...values };
  if (data.kind === "process") {
    // Custom type editors are interpreted by the server rule, including array semantics.
    if (!data.definition.editor.includes("internal_type")) return undefined;
    return normalizedDataType(current.internal_type ?? current.data_type);
  }
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


/** Impact snapshots come from the server; do not reconstruct workbook-specific fields here. */
export function pointChangeSummary(change: Row, fields?: Record<string, PointField>): string {
  const before = change.before || {}, after = change.after || {};
  const text = (value: unknown) => value !== null && typeof value === "object"
    ? JSON.stringify(value) : pointText(value);
  const labels: Record<string, string> = { display_order: "显示顺序", ordinal: "协议排列", effective_address: "协议地址", category: "数据分类" };
  return Object.keys({ ...before, ...after })
    .filter(key => !["project_id", "raw_json"].includes(key) && JSON.stringify(before[key]) !== JSON.stringify(after[key]))
    .map(key => `${fields?.[key]?.column_label || fields?.[key]?.label || labels[key] || key}：${text(before[key])} → ${text(after[key])}`)
    .join("；");
}
