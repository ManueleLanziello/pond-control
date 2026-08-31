const WEATHER_ICON_GROUPS = Object.freeze([
  { key: 'sun', src: '/icons/sun.svg', codes: [0, 1] },
  { key: 'cloud', src: '/icons/cloud.svg', codes: [2, 3, 45, 48] },
  { key: 'rain', src: '/icons/rain.svg', codes: [51, 53, 55, 56, 57, 61, 63, 65, 66, 67, 80, 81, 82] },
  { key: 'snow', src: '/icons/snow.svg', codes: [71, 73, 75, 77, 85, 86] },
  { key: 'storm', src: '/icons/storm.svg', codes: [95, 96, 99] },
]);

export function weatherIconForCode(code, fallback = { key: 'cloud', src: '/icons/cloud.svg' }) {
  const numericCode = Number(code);
  const group = WEATHER_ICON_GROUPS.find((item) => item.codes.includes(numericCode));
  return {
    key: group?.key || fallback.key,
    src: group?.src || fallback.src,
  };
}
