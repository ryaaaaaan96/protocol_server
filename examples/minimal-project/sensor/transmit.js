// Modbus addresses count registers. Display order never changes protocol order.
export default function calculate(points, parameters) {
  const sorted = [...points].sort((a, b) => {
    const left = a.source.enum_name, right = b.source.enum_name;
    return left < right ? -1 : left > right ? 1 : a.id - b.id;
  });
  let address = parameters.base_address;
  return sorted.map(point => {
    const length = point.wire_type === "STRING"
      ? point.source.byte_length : parameters.type_bytes[point.wire_type];
    if (!Number.isInteger(length) || length < 1) throw new Error("Unsupported wire length");
    const result = {id: point.id, address, wire_length: length};
    address += Math.ceil(length / 2);
    return result;
  });
}
