import { access, readFile } from 'node:fs/promises';
import { join } from 'node:path';

const BASELINE_FILES = {
  'dead-code': 'dead-code.json',
  dupes: 'dupes.json',
  health: 'health.json',
};

function usage() {
  return 'Usage: node scripts/check-fallow-baseline-drift.mjs --base <dir> --head <dir>';
}

function parseArgs(argv) {
  const args = new Map();
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i];
    const value = argv[i + 1];
    if (!key?.startsWith('--') || value === undefined) {
      throw new Error(usage());
    }
    args.set(key.slice(2), value);
  }
  const base = args.get('base');
  const head = args.get('head');
  if (!base || !head) throw new Error(usage());
  return { base, head };
}

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

function assertObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value;
}

function assertArray(value, label) {
  if (!Array.isArray(value)) {
    throw new Error(`${label} must be an array`);
  }
  return value;
}

function assertCount(value, label) {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative integer`);
  }
  return value;
}

function countDeadCode(doc) {
  const baseline = assertObject(doc, 'dead-code baseline');
  return Object.entries(baseline).reduce(
    (total, [key, value]) => total + assertArray(value, `dead-code.${key}`).length,
    0,
  );
}

function countDupes(doc) {
  const baseline = assertObject(doc, 'dupes baseline');
  return assertArray(baseline.clone_groups, 'dupes.clone_groups').length;
}

function countHealth(doc) {
  const baseline = assertObject(doc, 'health baseline');
  const files = assertObject(baseline.finding_counts, 'health.finding_counts');
  let total = 0;
  for (const [file, counts] of Object.entries(files)) {
    const findings = assertObject(counts, `health.finding_counts.${file}`);
    for (const [kind, finding] of Object.entries(findings)) {
      const details = assertObject(finding, `health.finding_counts.${file}.${kind}`);
      total += assertCount(details.count, `health.finding_counts.${file}.${kind}.count`);
    }
  }
  return total;
}

function count(kind, doc) {
  if (kind === 'dead-code') return countDeadCode(doc);
  if (kind === 'dupes') return countDupes(doc);
  return countHealth(doc);
}

async function compareBaseline(kind, file, baseDir, headDir) {
  const basePath = join(baseDir, file);
  const headPath = join(headDir, file);
  if (!(await exists(headPath))) {
    throw new Error(`${kind} baseline missing at ${headPath}`);
  }
  if (!(await exists(basePath))) {
    console.log(`${kind} baseline absent in base; allowing bootstrap`);
    return null;
  }
  const baseCount = count(kind, await readJson(basePath));
  const headCount = count(kind, await readJson(headPath));
  return { kind, baseCount, headCount };
}

async function main() {
  const { base, head } = parseArgs(process.argv.slice(2));
  const results = [];
  for (const [kind, file] of Object.entries(BASELINE_FILES)) {
    const result = await compareBaseline(kind, file, base, head);
    if (result) results.push(result);
  }

  const growth = results.filter((result) => result.headCount > result.baseCount);
  if (growth.length > 0) {
    for (const result of growth) {
      console.error(
        `${result.kind} baseline grew: ${result.baseCount} -> ${result.headCount}. Shrink or justify through a protected refresh.`,
      );
    }
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 2;
});
