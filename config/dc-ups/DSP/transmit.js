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
