// DSP worksheet semantics live with this table. The platform supplies stable
// row IDs, transactions and common storage validation.
const metadataColumns = {
  enum_table: "D", display_digits: "E", access: "M", ram: "N",
  flash: "O", eeprom: "P", calibration: "Q", structure: "R",
  cpu: "S", upload_level: "V", category: "W",
};
const widths = { U8: 1, U16: 2, S16: 2, U32: 4, S32: 4, F32: 4, STRING: 1 };
const types = ["U8", "U16", "S16", "U32", "S32", "F32"];
const own = (value, key) => Object.hasOwn(value, key);
const text = value => typeof value === "string" ? value : "";
const identifier = value => /^[A-Za-z_][A-Za-z0-9_]{0,159}$/.test(value);

function source(row, key, column) {
  const metadata = row.metadata || {};
  return own(metadata, key) ? metadata[key] : metadata.source_cells?.values?.[column];
}

function enumName(value) {
  const chars = [...value.trim()];
  let out = "";
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i];
    if (!/[A-Za-z0-9]/.test(ch)) {
      if (out && !out.endsWith("_")) out += "_";
      continue;
    }
    if (/[A-Z]/.test(ch) && i > 0
      && (/[a-z0-9]/.test(chars[i - 1])
        || /[A-Z]/.test(chars[i - 1]) && /[a-z]/.test(chars[i + 1] || ""))
      && !out.endsWith("_")) out += "_";
    out += ch.toUpperCase();
  }
  return out.replace(/^_+|_+$/g, "");
}

function digits(row) {
  const value = Number(source(row, "display_digits", "E"));
  return Number.isInteger(value) && value >= 0 && value <= 8 ? value : 0;
}

function recommendation(row) {
  const array = row.element_count > 1 || row.internal_type === "STRING";
  const wire = array ? "STRING" : row.internal_type === "F32" ? "S32" : row.internal_type;
  const fixed = !array && row.internal_type === "F32";
  return {
    recommended_wire_type: wire,
    recommended_wire_length: wire === "STRING" ? row.byte_length : widths[wire],
    recommended_scale: fixed ? 10 ** -digits(row) : 1,
    recommended_conversion: array ? "array_bytes" : fixed ? "fixed_point" : "identity",
  };
}

function project(row, parameters) {
  const original = text(source(row, "source_variable", "B"));
  const values = {
    variable_name: original && enumName(original) === row.enum_name ? original : row.enum_name,
    sheet_type: `Sys_${row.internal_type}`,
  };
  for (const [key, column] of Object.entries(metadataColumns)) {
    values[key] = key === "display_digits" ? digits(row) : text(source(row, key, column));
  }
  values.type_length = widths[row.internal_type] || 0;
  values.precision = values.display_digits === 0
    ? "1" : `0.${"0".repeat(values.display_digits - 1)}1`;
  Object.assign(values, recommendation(row));
  values.sheet_data_type = values.recommended_wire_type;
  values.sheet_upp_model = parameters.category_models[values.category] ?? "";
  const evidence = row.metadata?.source_cells?.values || {};
  values.source_values = {
    default_value: evidence.I ?? null,
    min_value: evidence.K ?? null,
    max_value: evidence.J ?? null,
  };
  return values;
}

function stringField(key, value) {
  if (typeof value !== "string" || value.length > 4096) {
    throw Error(`${key} 必须为不超过 4096 字符的文本`);
  }
  return value;
}

function normalize(context, parameters) {
  const fields = context.fields;
  const values = { ...fields };
  const readonly = [
    "metadata", "type_length", "precision", "sheet_data_type", "sheet_upp_model",
    "recommended_wire_type", "recommended_wire_length", "recommended_scale", "recommended_conversion",
  ];
  if (readonly.some(key => own(fields, key))) throw Error("来源元数据和派生列不能直接修改");
  const metadata = { ...(context.row.metadata || {}) };
  let changed = false;
  if (own(fields, "variable_name")) {
    const variable = stringField("variable_name", fields.variable_name).trim();
    const normalized = enumName(variable);
    if (!identifier(variable) || !identifier(normalized)) {
      throw Error("VariateName 必须为有效变量名，最长 160 个字符");
    }
    if (own(fields, "enum_name") && fields.enum_name !== normalized) {
      throw Error("VariateName 与枚举字段不一致");
    }
    values.enum_name = normalized;
    metadata.source_variable = variable;
    delete values.variable_name;
    changed = true;
  }
  if (own(fields, "sheet_type")) {
    const value = stringField("sheet_type", fields.sheet_type);
    const typ = value.startsWith("Sys_") ? value.slice(4) : "";
    if (!types.includes(typ)) {
      throw Error("DateType 必须为 Sys_U8 / Sys_U16 / Sys_S16 / Sys_U32 / Sys_S32 / Sys_F32");
    }
    if (own(fields, "internal_type") && fields.internal_type !== typ) {
      throw Error("DateType 与内部类型字段不一致");
    }
    values.internal_type = typ;
    delete values.sheet_type;
  }
  for (const key of Object.keys(metadataColumns)) {
    if (!own(fields, key)) continue;
    const value = fields[key];
    if (key === "display_digits") {
      if (!Number.isInteger(value) || value < 0 || value > 8) throw Error("DisplayDigit 必须为 0～8 的整数");
    } else {
      stringField(key, value);
      const options = parameters.value_options[key];
      const valid = !value || (options ? options.includes(value)
        : key === "category" ? own(parameters.category_models, value)
        : key === "structure" ? identifier(value) : true);
      if (!valid) throw Error(`${key} 的值不符合 DSP内部数据 工作表规则`);
    }
    metadata[key] = value;
    delete values[key];
    changed = true;
  }
  if (changed) values.metadata = metadata;
  return { values };
}

export function behavior(context, parameters) {
  switch (context.action) {
    case "project":
      return context.rows.map(row => ({ id: row.id, values: project(row, parameters) }));
    case "normalize":
      return normalize(context, parameters);
    case "reconcile":
      return context.rows.map(row => ({ id: row.id, values: {} }));
    case "validate":
      return [];
    default:
      throw Error(`不支持的表行为：${context.action}`);
  }
}
