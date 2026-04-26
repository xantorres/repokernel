export function yamlArray(values: readonly string[]): string {
  if (values.length === 0) return '[]';
  return `\n${values.map((v) => `  - ${yamlScalar(v)}`).join('\n')}`;
}

export function yamlScalar(value: string | null): string {
  return value === null ? 'null' : JSON.stringify(value);
}
