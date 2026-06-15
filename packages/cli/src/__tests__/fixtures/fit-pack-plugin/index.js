// Fixture fit-pack barrel. The loader (`loadDiscoveredCheckPackages`) gates
// on a `checks` array of Check objects (the return value of `defineCheck`).
// No `recipes` export — recipesRegistered=0 is a valid fit-pack shape.
import { fitPackFixtureCheck } from './check.js';

export const checks = [fitPackFixtureCheck];
