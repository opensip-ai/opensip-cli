// A ROOT-LEVEL file (under no packages/* unit → the synthetic `:root` shard).
// rootRun -> @medium/app.appMain is a cross-package edge originating OUTSIDE
// packages/* (packageOf is `<unknown>`). Proves boundary linking from the root
// shard at medium scale, with the imported package absent from the root shard.

import { appMain } from '@medium/app';

export function rootRun(value: unknown): unknown {
  return appMain(value);
}
