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
});

export const SUPPORTED_PLUG_MODELS = Object.freeze(Object.values(MODELS));

export function supportedPlugModel(model) {
  return MODELS[String(model || '').trim().toUpperCase()] || null;
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

export function isRuntimeEligiblePlug(record) {
  return Boolean(
    supportedPlugModel(record.model)
    && record.configurationStatus === 'complete'
    && record.verificationStatus === 'verified',
  );
}
