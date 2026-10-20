// Consume the source table's calculated instance address; keep one formula owner.
export default function calculate(points, parameters) {
  return points.flatMap(point => point.devices.map(device => ({
    source_id: point.source_id,
    device_code: device.code,
    address: device.address,
    dev_id: parameters.upm_dev_id,
  })));
}
