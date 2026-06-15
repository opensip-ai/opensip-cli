// Proof fixture for the read-before-import contract: if loadToolManifest
// (or anything else under test) imports this module, it throws immediately.
// A passing manifest-load test therefore proves the loader read the static
// package.json#opensipTools WITHOUT importing the tool's runtime module.
throw new Error('throw-on-import fixture was imported — read-before-import violated');
