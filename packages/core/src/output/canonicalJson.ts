export function canonicalJson(value: unknown): string {
  return stringify(value, '') + '\n';
}

function stringify(value: unknown, indent: string): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new Error('canonicalJson: non-finite number');
    }
    return JSON.stringify(value);
  }
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (Array.isArray(value)) return stringifyArray(value, indent);
  if (typeof value === 'object') return stringifyObject(value as Record<string, unknown>, indent);
  throw new Error(`canonicalJson: unsupported type ${typeof value}`);
}

function stringifyArray(arr: readonly unknown[], indent: string): string {
  if (arr.length === 0) return '[]';
  const inner = indent + '  ';
  const items = arr.map((v) => inner + stringify(v, inner));
  return '[\n' + items.join(',\n') + '\n' + indent + ']';
}

function stringifyObject(obj: Record<string, unknown>, indent: string): string {
  const keys = Object.keys(obj).sort();
  if (keys.length === 0) return '{}';
  const inner = indent + '  ';
  const lines = keys.map((k) => inner + JSON.stringify(k) + ': ' + stringify(obj[k], inner));
  return '{\n' + lines.join(',\n') + '\n' + indent + '}';
}
