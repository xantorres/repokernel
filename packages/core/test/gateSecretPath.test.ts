import { homedir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { gateSecretPath } from '../src/index.js';

describe('gateSecretPath', () => {
  const fixed = join(homedir(), '.repokernel', 'gate.key');

  it('defaults to ~/.repokernel/gate.key regardless of REPOKERNEL_TRUST_FILE', () => {
    // The trust-file env must NOT move the key — a reviewer subprocess with it
    // set could otherwise redirect the signing key path as a side effect.
    expect(gateSecretPath({ REPOKERNEL_TRUST_FILE: '/tmp/a/trust.yaml' })).toBe(fixed);
    expect(gateSecretPath({ REPOKERNEL_TRUST_FILE: '/tmp/b/trust.yaml' })).toBe(fixed);
    expect(gateSecretPath({})).toBe(fixed);
  });

  it('honors the explicit REPOKERNEL_GATE_SECRET_FILE override', () => {
    expect(gateSecretPath({ REPOKERNEL_GATE_SECRET_FILE: '/custom/k.key' })).toBe('/custom/k.key');
  });

  it('lets the explicit override win even when the trust-file env is also set', () => {
    expect(
      gateSecretPath({
        REPOKERNEL_TRUST_FILE: '/tmp/a/trust.yaml',
        REPOKERNEL_GATE_SECRET_FILE: '/custom/k.key',
      }),
    ).toBe('/custom/k.key');
  });
});
