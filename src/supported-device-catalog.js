const MODELS = Object.freeze({
  P105: Object.freeze({
    manufacturer: 'TP-Link Tapo', model: 'P105', adapter: 'tpap',
    protocol: 'tpap', protocolLabel: 'TPAP/SPAKE2+', type: 'SMART.TAPOPLUG',
    capabilities: Object.freeze(['switch', 'signal']), supported: true,
  }),
  P100M: Object.freeze({
    manufacturer: 'TP-Link Tapo', model: 'P100M', adapter: 'tpap',
    protocol: 'tpap', protocolLabel: 'TPAP/SPAKE2+', type: 'SMART.TAPOPLUG',
    capabilities: Object.freeze(['switch', 'signal']), supported: true,
  }),
  DEWIN_EXTERNAL_PROBE: Object.freeze({
    category: 'sensor', manufacturer: 'Dewin', model: 'T & H Sensor with external probe', adapter: 'tuya-cloud',
    provider: 'Tuya Cloud', protocol: 'tuya-cloud', protocolLabel: 'Tuya Cloud HTTPS', connectionType: 'cloud',
    type: 'Sensore temperatura con sonda esterna', identityField: 'tuyaDeviceId',
    capabilities: Object.freeze(['external_probe_temperature', 'ambient_temperature', 'humidity', 'battery', 'timestamp']), supported: true,
  }),
  C410: Object.freeze({
    category: 'camera', manufacturer: 'TP-Link Tapo', model: 'C410', adapter: 'pytapo-https',
    streamAdapter: 'pytapo-media-ffmpeg', provider: 'PyTapo', protocol: 'pytapo-https', protocolLabel: 'PyTapo HTTPS',
    connectionType: 'lan', type: 'Telecamera IP', capabilities: Object.freeze(['snapshot', 'live_stream']),
    dependencies: Object.freeze(['PyTapo', 'ffmpeg']), supported: true,
  }),
});

const ALL_MODELS = Object.freeze(Object.values(MODELS).map((entry) => Object.freeze({ category: entry.category || 'plug', connectionType: entry.connectionType || 'lan', ...entry })));
export const SUPPORTED_DEVICE_MODELS = ALL_MODELS;
export const SUPPORTED_PLUG_MODELS = Object.freeze(ALL_MODELS.filter(({ category }) => category === 'plug'));
export const SUPPORTED_SENSOR_MODELS = Object.freeze(ALL_MODELS.filter(({ category }) => category === 'sensor'));
export const SUPPORTED_CAMERA_MODELS = Object.freeze(ALL_MODELS.filter(({ category }) => category === 'camera'));

export function supportedPlugModel(model) {
  return SUPPORTED_PLUG_MODELS.find((entry) => entry.model.toUpperCase() === String(model || '').trim().toUpperCase()) || null;
}

export function supportedDeviceModel(category, model) {
  return ALL_MODELS.find((entry) => entry.category === category && entry.model.toUpperCase() === String(model || '').trim().toUpperCase()) || null;
}
export const supportedSensorModel = (model) => supportedDeviceModel('sensor', model);
export const supportedCameraModel = (model) => supportedDeviceModel('camera', model);

export function requireSupportedDeviceModel(category, model) {
  const definition = supportedDeviceModel(category, model);
  if (!definition) {
    const labels = { plug: 'presa', sensor: 'sensore', camera: 'telecamera' };
    const error = new Error(`Modello ${labels[category] || 'dispositivo'} non supportato: ${String(model || '').trim() || 'non specificato'}.`);
    error.code = 'UNSUPPORTED_MODEL'; throw error;
  }
  return definition;
}

export function requireSupportedPlugModel(model) {
  const definition = supportedPlugModel(model);
  if (!definition) {
    const error = new Error(`Modello presa non supportato: ${String(model || '').trim() || 'non specificato'}.`);
    error.code = 'UNSUPPORTED_MODEL';
    throw error;
  }
  return definition;
}

export function runtimePlugConfiguration(record) {
  const definition = requireSupportedPlugModel(record.model);
  return {
    id: record.id,
    fallbackName: record.alias,
    model: definition.model,
    manufacturer: definition.manufacturer,
    ip: record.ip,
    type: definition.type,
    protocol: definition.protocol,
    protocolLabel: definition.protocolLabel,
    adapter: definition.adapter,
  };
}

export function runtimeConfiguration(category, record) {
  const definition = requireSupportedDeviceModel(category, record.model);
  return { id: record.id, fallbackName: record.alias, model: definition.model, manufacturer: definition.manufacturer,
    adapter: definition.adapter, protocol: definition.protocol, protocolLabel: definition.protocolLabel,
    connectionType: definition.connectionType, type: definition.type,
    ...(category === 'sensor' ? { tuyaDeviceId: record.tuyaDeviceId } : { ip: record.ip, mac: record.mac }) };
}

export function isRuntimeEligible(category, record) {
  return Boolean(supportedDeviceModel(category, record.model) && record.configurationStatus === 'complete' && record.verificationStatus === 'verified');
}

export function isRuntimeEligiblePlug(record) {
  return Boolean(
    supportedPlugModel(record.model)
    && record.configurationStatus === 'complete'
    && record.verificationStatus === 'verified',
  );
}
