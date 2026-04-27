import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const _dir = dirname(fileURLToPath(import.meta.url));

export const RK_VERSION = (
  JSON.parse(readFileSync(join(_dir, '../package.json'), 'utf8')) as { version: string }
).version;

export const RK_GENERATED_BY = `repokernel@${RK_VERSION}`;
