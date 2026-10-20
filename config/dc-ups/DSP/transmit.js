// One script per table. Each invocation receives a fresh snapshot.
// UI display order is deliberately excluded from the calculation.
export default function calculate(points, parameters) {
  const ordered = [...points].sort((a, b) => {
    if (a.upp_model !== b.upp_model) return a.upp_model - b.upp_model;
    if (a.upload_level !== b.upload_level) return a.upload_level > b.upload_level ? -1 : 1;
    return a.source_order - b.source_order
      || a.process_point_id - b.process_point_id
      || a.id - b.id;
  });
  const used = new Map();
  return ordered.map(point => {
    const length = point.wire_type === "STRING"
      ? point.byte_length
      : parameters.type_bytes[point.wire_type];
    const group = `${point.endpoint_key}:${point.upp_model}`;
    const preceding = used.get(group) ?? 0;
    const address = Object.hasOwn(parameters.fixed_offsets, point.name)
      ? parameters.fixed_offsets[point.name]
      : parameters.header_bytes + preceding;
    // Like Excel SUMIF: fixed-offset rows still contribute their lengths.
    used.set(group, preceding + length);
    return { id: point.id, address, wire_length: length };
  });
}

// The linked source has already been projected by process.js. Its category
// models and suggested wire representation are therefore defined in one place.
const own = (value, key) => Object.hasOwn(value, key);
const widths = { U8: 1, U16: 2, S16: 2, U32: 4, S32: 4, F32: 4 };

function conversion(source, wire) {
  if (wire === "STRING") return "array_bytes";
  if (source.internal_type === "F32" && source.element_count === 1 && wire === "S32") return "fixed_point";
  return "identity";
}

function requiredModel(source) {
  const model = source.sheet_upp_model;
  if (!Number.isInteger(model) || model < 0 || model > 65535) {
    throw Error("此板卡转发需要内部点具有有效的数据分类，请先设置数据分类");
  }
  return model;
}

function normalize(context) {
  const source = context.source;
  const fields = context.fields;
  const values = { ...fields };
  if (!source || !source.id) throw Error("转发必须关联当前板卡的内部数据点");
  if (own(fields, "enabled") && fields.enabled !== true) {
    throw Error("此板卡的转发表记录全部参与转发，不再支持停用；不需要转发时请删除映射");
  }
  const model = requiredModel(source);
  if (own(fields, "upp_model") && fields.upp_model !== model) {
    throw Error(`UPP 模型号由内部数据分类「${source.category}」固定推导为 ${model}，不能手动修改`);
  }
  const wire = fields.wire_type ?? (context.operation === "create"
    ? source.recommended_wire_type : context.row.wire_type);
  if (context.operation === "create") {
    if (!own(fields, "wire_type")) values.wire_type = wire;
    if (!own(fields, "wire_length")) values.wire_length = wire === "STRING" ? source.byte_length : widths[wire];
    if (!own(fields, "scale")) values.scale = conversion(source, wire) === "fixed_point"
      ? source.recommended_scale : 1;
  }
  return { values: {
    ...values, name: source.name, enabled: true, upp_model: model,
    conversion: conversion(source, wire), byte_order: 0,
  } };
}

function projected(row, source) {
  return {
    name: source.name,
    field_name: source.name,
    enabled: true,
    conversion: conversion(source, row.wire_type),
    byte_order: 0,
    category: source.category,
    variable_name: source.variable_name,
    sheet_type: source.sheet_type,
    recommended_wire_type: source.recommended_wire_type,
    recommended_wire_length: source.recommended_wire_length,
    recommended_scale: source.recommended_scale,
    recommended_conversion: source.recommended_conversion,
  };
}

export function behavior(context) {
  if (context.action === "normalize") return normalize(context);
  const sources = new Map(context.sources.map(row => [row.id, row]));
  if (context.action === "validate") {
    const issues = [];
    for (const row of context.rows) {
      const source = sources.get(row.process_point_id);
      if (!source) continue; // The common reference validator reports this.
      if (!Number.isInteger(source.sheet_upp_model) || source.sheet_upp_model !== row.upp_model) {
        issues.push({ id: row.id, code: "upp_model_category", level: "error", related_id: source.id,
          message: "UPP 模型号必须由所关联内部点的有效数据分类固定推导" });
      }
      if (row.wire_type !== source.recommended_wire_type) {
        issues.push({ id: row.id, code: "wire_type_suggestion", level: "warning", related_id: source.id,
          field: "wire_type", recommended_wire_type: source.recommended_wire_type, actual_wire_type: row.wire_type,
          message: `通信类型 ${row.wire_type} 与 DateType / ArrayCnt 建议的 ${source.recommended_wire_type} 不同；当前采用手动配置，请确认通信双方一致` });
      }
    }
    return issues;
  }
  return context.rows.map(row => {
    const source = sources.get(row.process_point_id);
    if (!source) throw Error("转发必须关联当前板卡的内部数据点");
    if (context.action === "project") return { id: row.id, values: projected(row, source) };
    if (context.action === "reconcile") return { id: row.id, values: {
      name: source.name, enabled: true, upp_model: requiredModel(source),
      conversion: conversion(source, row.wire_type), byte_order: 0,
    } };
    throw Error(`不支持的表行为：${context.action}`);
  });
}
