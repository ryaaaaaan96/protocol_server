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
  kind: PointKind;
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

/** Resolve the draft's effective internal type, respecting inherited definitions. */
export function pointDataType(
  data: PointTableData,
  values: Row,
  fallbackRow?: Row,
): string | undefined {
  const original = { ...fallbackRow, ...fallbackRow?.edit_values };
  const current = { ...original, ...values };
  if (data.kind === "process") {
    const override = normalizedDataType(current.internal_type);
    if (override) return override;
    const definition = data.options.data?.find(
      (item) => item.id === current.data_item_id,
    );
    const inherited = normalizedDataType(definition?.data_type);
    if (inherited) return inherited;
    // An old snapshot is only safe while neither source of the type changed.
    if (
      current.data_item_id === original.data_item_id &&
      normalizedDataType(current.internal_type) ===
        normalizedDataType(original.internal_type)
    )
      return normalizedDataType(fallbackRow?.data_type);
  } else {
    const signal = data.options.signals?.find(
      (item) => item.id === current.signal_id,
    );
    const type = normalizedDataType(signal?.data_type);
    if (type) return type;
    if (current.signal_id === original.signal_id)
      return normalizedDataType(fallbackRow?.data_type);
  }
  return undefined;
}

export function pointIsString(
  data: PointTableData,
  values: Row,
  fallbackRow?: Row,
): boolean {
  return isStringType(pointDataType(data, values, fallbackRow));
}

export function pointGroupLabel(group: Row): string {
  const names: Record<string, string> = {
    ARM_LOCAL: "LOCAL · 本机数据",
    DSP_LOCAL: "LOCAL · DSP 内部数据",
    DSP_PROXY: "DSP · 下级 DSP 数据",
  };
  return names[group.code] || `${group.code} · ${group.name}`;
}

// All relations refer to stable record IDs. Captions and sigID are display values.
export function pointChoices(
  data: PointTableData,
  key: string,
  values: Row,
): Row[] {
  const field = data.definition.fields[key];
  const all = data.options[field.reference || ""] || [];
  if (key === "endpoint_id")
    return all.filter(
      (e) => e.role === (data.kind === "collect" ? "client" : "server"),
    );
  if (key === "context_id") return all.filter((c) => c.group_id != null);
  if (key === "signal_id") {
    const context = data.options.contexts.find(
      (c) => c.id === values.context_id,
    );
    return context ? all.filter((s) => s.group_id === context.group_id) : [];
  }
  if (key === "field_id") {
    const endpoint = data.options.endpoints.find(
      (e) => e.id === values.endpoint_id,
    );
    return endpoint
      ? all.filter((f) => f.contract_id === endpoint.contract_id)
      : [];
  }
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
