#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

const out = process.env.FAKE_OMP_OUT;
const loader = (() => {
  try {
    const file = path.join(process.env.HOME || process.env.USERPROFILE || '', '.omp', 'agent', 'extensions', 'agy-crew-omp.ts');
    return { path: file, content: fs.readFileSync(file, 'utf8') };
  } catch { return null; }
})();
if (out) {
  fs.writeFileSync(out, JSON.stringify({
    argv: process.argv.slice(2),
    account: process.env.AGY_CREW_OMP_ACCOUNT,
    family: process.env.AGY_CREW_OMP_FAMILY,
    hold: process.env.AGY_CREW_OMP_HOLD,
    home: process.env.AGY_CREW_HOME,
    firstEventTimeout: process.env.PI_STREAM_FIRST_EVENT_TIMEOUT_MS,
    loader,
    holds: (() => { try { const p = JSON.parse(fs.readFileSync(path.join(process.env.AGY_CREW_HOME, 'pool.json'), 'utf8')); return p.leases.filter((l) => l.role === 'hold').length; } catch { return -1; } })(),
  }, null, 2));
}
setTimeout(() => process.exit(0), 50);
