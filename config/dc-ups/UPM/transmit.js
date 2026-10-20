// Display instances only; the shared template and protocol values stay in storage.
export function behavior(context) {
  if (context.action === "normalize") return { values: context.fields };
  if (context.action === "validate") return [];
  if (context.action === "reconcile") return context.rows.map(row => ({ id: row.id, values: {} }));
  if (context.action !== "project") throw Error(`不支持的表行为：${context.action}`);
  return context.rows.map(row => ({
    id: row.id,
    // Protocol validation also projects raw storage rows; instance display
    // context is supplied only when reading a table, and never affects safety.
    values: row.device_instances ? {
      instance_rows: row.device_instances.map(device => ({
        instance_device: device.code,
        address: device.address,
      })),
    } : {},
  }));
}
