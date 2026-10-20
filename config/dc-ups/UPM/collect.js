function checkedBase(value) {
  if (value != null && (!Number.isInteger(value) || value < 0 || value > 65535)) throw Error("Base 地址必须为空或 0～65535 的整数");
  return value;
}

function displayedBase(row, source) {
  if (row.metadata?.base_address != null) return checkedBase(row.metadata.base_address);
  const addresses = [...new Set((source?.transmissions || []).filter(mapping => mapping.protocol === "MODBUS").map(mapping => mapping.address))];
  return addresses.length === 1 ? addresses[0] : null;
}

export function behavior(context) {
  if (context.action === "normalize") {
    const values = { ...context.fields };
    if (Object.hasOwn(values, "base_address")) {
      const base = checkedBase(values.base_address);
      values.metadata = { ...context.row.metadata };
      if (base == null) delete values.metadata.base_address;
      else values.metadata.base_address = base;
      delete values.base_address;
    }
    return { values };
  }
  if (context.action === "validate") {
    for (const row of context.rows) checkedBase(row.metadata?.base_address);
    return [];
  }
  if (context.action === "reconcile") return context.rows.map(row => ({ id: row.id, values: {} }));
  if (context.action !== "project") throw Error(`不支持的表行为：${context.action}`);
  const sources = new Map(context.sources.map(source => [source.id, source]));
  return context.rows.map(row => ({ id: row.id, values: { base_address: displayedBase(row, sources.get(row.process_point_id)) } }));
}
