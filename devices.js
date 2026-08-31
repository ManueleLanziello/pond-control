export const devices = Object.freeze([
  Object.freeze({
    id: 'tapo-p105-pond',
    role: 'pump',
    fallbackName: 'Pompa Filtro Pond',
    model: 'P105',
    ip: '192.168.1.5',
    type: 'SMART.TAPOPLUG',
    protocol: 'tpap',
    protocolLabel: 'TPAP/SPAKE2+',
  }),
  Object.freeze({
    id: 'tapo-p100m-pond',
    role: 'heater',
    fallbackName: 'Riscaldatore Pond',
    model: 'P100M',
    ip: '192.168.1.20',
    type: 'SMART.TAPOPLUG',
    protocol: 'tpap',
    protocolLabel: 'TPAP/SPAKE2+',
  }),
]);
