import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(__dirname, '..', '..', '..');
const INPUTS_VERSION_EXPR = '$' + '{{ inputs.version }}';
const FINDINGS_JSON_EXPR = '$' + '{{ steps.run.outputs.findings-json }}';
const PACK_OUTPUT_EXPR = '$' + '{{ steps.pack.outputs.package }}';
const EXIT_CODE_EXPR = '$' + '{{ steps.run.outputs.exit-code }}';

async function actionYaml(): Promise<string> {
  return readFile(resolve(ROOT, '.github/actions/rk-validate/action.yml'), 'utf8');
}

async function smokeWorkflowYaml(): Promise<string> {
  return readFile(resolve(ROOT, '.github/workflows/test-action.yml'), 'utf8');
}

describe('rk-validate GitHub Action hardening', () => {
  it('does not interpolate action inputs directly into shell install commands', async () => {
    const yaml = await actionYaml();
    expect(yaml).toContain('INPUT_VERSION');
    expect(yaml).not.toContain(`npm install -g repokernel@${INPUTS_VERSION_EXPR}`);
    expect(yaml).toContain('npm install -g "repokernel@$INPUT_VERSION"');
  });

  it('passes findings-json to github-script through env', async () => {
    const yaml = await actionYaml();
    expect(yaml).toContain(`FINDINGS_JSON: ${FINDINGS_JSON_EXPR}`);
    expect(yaml).toContain('process.env.FINDINGS_JSON');
    expect(yaml).toContain('working-directory must resolve under GITHUB_WORKSPACE');
    expect(yaml).not.toContain(
      `path.resolve(process.env.GITHUB_WORKSPACE, '${FINDINGS_JSON_EXPR}')`,
    );
  });

  it('keeps report steps reachable on findings and fails only after reporting', async () => {
    const yaml = await actionYaml();
    expect(yaml).toContain('Fail after RepoKernel reporting');
    expect(yaml).toContain("steps.run.outputs.exit-code == '1'");
    expect(yaml).toContain("steps.run.outputs.exit-code == '2'");
    expect(yaml).toMatch(/always\(\)[\s\S]+steps\.run\.outputs\.findings-json != ''/);
  });

  it('exposes treat-runtime-as input that gates exit-code 2 propagation', async () => {
    const yaml = await actionYaml();
    expect(yaml).toContain('treat-runtime-as:');
    expect(yaml).toContain("inputs.treat-runtime-as != 'neutral'");
  });

  it('passes the runtime exit code through env, not direct YAML interpolation', async () => {
    const yaml = await actionYaml();
    expect(yaml).toContain(`RK_EXIT_CODE: ${EXIT_CODE_EXPR}`);
    expect(yaml).toContain('exit "$RK_EXIT_CODE"');
    expect(yaml).not.toContain(`exit "${EXIT_CODE_EXPR}"`);
  });

  it('escapes workflow command annotation fields', async () => {
    const yaml = await actionYaml();
    expect(yaml).toContain('escape_github_data');
    expect(yaml).toContain('escape_github_property');
  });

  it('smoke workflow installs the local PR package, not npm latest', async () => {
    const yaml = await smokeWorkflowYaml();
    expect(yaml).toContain('pnpm --filter repokernel pack');
    expect(yaml).toContain(`version: file:${PACK_OUTPUT_EXPR}`);
    expect(yaml).not.toContain('accept that it pulls the published latest');
  });
});
