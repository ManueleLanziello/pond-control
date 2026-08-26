export function debug(...values) {
  if (process.env.TAPO_DEBUG === '1') console.error(...values);
}

export function info(...values) {
  console.log(...values);
}

export function error(...values) {
  console.error(...values);
}
