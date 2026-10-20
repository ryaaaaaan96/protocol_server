// Modbus addresses count registers. Each DSP template offset is added to its
// device base; LOCAL uses base 0. All rows are read from the same UPM slave.
export default function calculate(points, parameters) {
  return points.flatMap(point => point.devices.map(device => ({
    source_id: point.source_id,
    device_code: device.code,
    address: point.address + device.modbus_base,
    dev_id: parameters.upm_dev_id,
  })));
}
