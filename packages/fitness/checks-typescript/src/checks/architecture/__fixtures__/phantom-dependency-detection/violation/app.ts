// Violation: imports a package that is not declared in package.json. Under
// pnpm's strict node_modules isolation this is a phantom dependency.
import { handler } from 'undeclared-pkg'

export const value = handler
