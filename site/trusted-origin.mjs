export function validProductionHostname(value) {
  return typeof value === 'string' && value.length <= 253
    && /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(value)
    && !/(?:^|\.)example\.(?:com|net|org)$/.test(value)
    && !/(?:^|\.)(?:localhost|example|invalid|test|local|internal)$/.test(value);
}
export function validProductionOrigin(value) {
  if (typeof value !== 'string' || !value.startsWith('https://')) return false;
  return validProductionHostname(value.slice(8));
}
