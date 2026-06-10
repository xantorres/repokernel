import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// The reviewer-gate signing key no longer co-locates with REPOKERNEL_TRUST_FILE
// (decoupled so a subprocess cannot redirect the key path via that env). Pin it
// to an isolated temp path for the whole test process so no test ever reads or
// writes the developer's real ~/.repokernel/gate.key. The key is a signing
// secret, not per-repo state, so one path per worker is fine.
if (!process.env.REPOKERNEL_GATE_SECRET_FILE) {
  const dir = mkdtempSync(join(tmpdir(), 'rk-gatekey-'));
  process.env.REPOKERNEL_GATE_SECRET_FILE = join(dir, 'gate.key');
}
