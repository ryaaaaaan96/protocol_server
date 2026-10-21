// Project-specific input, projection and validation; no database access.
export function behavior(context, parameters) {
  if (context.action === "normalize") {
    const values = {...context.fields};
    delete values.gain;
    if (Object.hasOwn(context.fields, "gain")) {
      values.metadata = {...context.row.metadata, gain: Number(context.fields.gain)};
    }
    return {values};
  }
  if (context.action === "project") {
    return context.rows.map(row => {
      const gain = row.metadata.gain ?? parameters.default_gain;
      return {id: row.id, values: {gain, calibrated_label: `${row.name} × ${gain}`}};
    });
  }
  if (context.action === "reconcile") return context.rows.map(row => ({id: row.id, values: {}}));
  if (context.action === "validate") {
    return context.rows.flatMap(row => {
      const gain = row.metadata.gain ?? parameters.default_gain;
      return Number.isInteger(gain) && gain >= 1 && gain <= parameters.max_gain ? [] : [{
        id: row.id, level: "error", code: "gain_range", message: `校准系数须为 1～${parameters.max_gain} 的整数`,
      }];
    });
  }
  throw new Error(`Unsupported action: ${context.action}`);
}
