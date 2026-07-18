/**
 * Echo the worker argv over the worker's normal result protocol.
 *
 * Both external-command and capability supervisors use this fixture so their
 * tests observe the actual arguments received by a forked Node process rather
 * than a mocked descriptor.
 */

import { readFileSync } from 'node:fs';

const argv = process.argv.slice(2);
const capabilityWorker = argv.includes('__capability-pack-worker');
const value = capabilityWorker
  ? argv
  : {
      output: 'command-result',
      returned: {
        argv,
        specCwd: JSON.parse(readFileSync(argv[1], 'utf8')).opts.cwd,
      },
    };

await new Promise((resolve, reject) => {
  if (process.send === undefined) {
    reject(new Error('worker argv probe requires an IPC channel'));
    return;
  }
  process.send({ kind: 'result', value }, (error) => {
    if (error === null) resolve();
    else reject(error);
  });
});
