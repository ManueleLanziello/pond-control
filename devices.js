export const devices = Object.freeze([
  Object.freeze({
    id: 'pond-pump',
    fallbackName: 'Pompa Laghetto',
    model: 'P105',
    ip: '192.168.1.5',
    type: 'SMART.TAPOPLUG',
    protocol: 'tpap',
    protocolLabel: 'TPAP/SPAKE2+',
  }),
  Object.freeze({
    id: 'fan',
    fallbackName: 'Ventilatore',
    model: 'P100M',
    ip: '192.168.1.20',
    type: 'SMART.TAPOPLUG',
    protocol: 'tpap',
    protocolLabel: 'TPAP/SPAKE2+',
  }),
]);
