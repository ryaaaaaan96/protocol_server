// Modbus instance formula: k * device_stride + template_base + base_address.
// k is the stable, zero-based instance_index, independent of dev_id.
function calculateInstances(rows, parameters) {
  return rows.flatMap(row => row.devices.map(device => {
    let address = row.base_address;
    if (row.protocol === "MODBUS") {
      const layout = parameters.modbus_layouts[row.group_key];
      if (!layout) throw Error(`分组 ${row.group_key} 缺少 modbus_layouts 配置`);
      address = device.instance_index * layout.device_stride + layout.template_base + row.base_address;
    }
    return { id: row.id, device_code: device.code, address };
  }));
}

function collectionBase(source) {
  const values = (source?.collections || []).map(row => row.metadata?.base_address).filter(value => value != null);
  if (values.some(value => !Number.isInteger(value) || value < 0 || value > 65535)) throw Error("采集 Base 地址必须为 0～65535 的整数");
  const unique = [...new Set(values)];
  if (unique.length > 1) throw Error("同一内部点的采集 Base 地址不一致，请批量统一后保存");
  return unique[0];
}

function protocol(source, endpointKey) {
  return source?.endpoints?.find(endpoint => endpoint.code === endpointKey)?.protocol;
}

export function behavior(context, parameters) {
  if (context.action === "instances") return calculateInstances(context.rows, parameters);
  if (context.action === "normalize") {
    const base = collectionBase(context.source);
    const endpoint = context.fields.endpoint_key ?? context.row.endpoint_key;
    if (protocol(context.source, endpoint) === "MODBUS" && base != null &&
      Object.hasOwn(context.fields, "address") && context.fields.address !== base) {
      throw Error("此转发偏移由采集表 Base 地址联动，请在采集表修改");
    }
    return { values: context.fields };
  }
  if (context.action === "validate") return [];
  const sources = new Map(context.sources.map(source => [source.id, source]));
  if (context.action === "reconcile") return context.rows.map(row => {
    const source = sources.get(row.process_point_id);
    const base = collectionBase(source);
    return { id: row.id, values: protocol(source, row.endpoint_key) === "MODBUS" && base != null ? { address: base } : {} };
  });
  if (context.action !== "project") throw Error(`不支持的表行为：${context.action}`);
  return context.rows.map(row => ({
    id: row.id,
    values: row.device_instances ? {
      instance_rows: row.device_instances.map(device => ({ instance_device: device.code, address: device.address })),
    } : {},
  }));
}
