import { execFile } from 'node:child_process';

import { defineTool } from '@opensip-cli/core';
import { SessionRepo } from '@opensip-cli/session-store';

console.log(SessionRepo);

export const tool = defineTool({});

execFile('scanner', []);
