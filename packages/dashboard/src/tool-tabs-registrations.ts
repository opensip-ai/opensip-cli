/**
 * First-party tool-tab registrations.
 *
 * Imported once from `generator.ts` so the side-effect registers the
 * fit / sim / graph tabs into the `defineToolTab` registry before the
 * generator iterates it. The registration order here is the tab-bar
 * order — Overview is fixed first by the generator, then this list
 * defines the rest.
 *
 * To add a new first-party tab: append a `defineToolTab(...)` call
 * here and ensure the corresponding `dashboard*Js` emitter declares a
 * `renderFunctionName` matching the descriptor.
 *
 * Third-party tools that ship their own dashboard tabs would import
 * `defineToolTab` from this package and call it at their own module
 * load — no changes needed here.
 */

import { defineToolTab } from './tool-tab-registry.js';

const FITNESS_ICON = String.raw`<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.596 12.768a2 2 0 1 0 2.829-2.829l-1.768-1.767a2 2 0 0 0 2.828-2.829l-2.828-2.828a2 2 0 0 0-2.829 2.828l-1.767-1.768a2 2 0 1 0-2.829 2.829z"/><path d="m2.5 21.5 1.4-1.4"/><path d="m20.1 3.9 1.4-1.4"/><path d="M5.343 21.485a2 2 0 1 0 2.829-2.828l1.767 1.768a2 2 0 1 0 2.829-2.829l-6.364-6.364a2 2 0 1 0-2.829 2.829l1.768 1.767a2 2 0 0 0-2.828 2.829z"/><path d="m9.6 14.4 4.8-4.8"/></svg>`;

const SIMULATION_ICON = String.raw`<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2v6a2 2 0 0 0 .245.96l5.51 10.08A2 2 0 0 1 18 22H6a2 2 0 0 1-1.755-2.96l5.51-10.08A2 2 0 0 0 10 8V2"/><path d="M6.453 15h11.094"/><path d="M8.5 2h7"/></svg>`;

const CODE_PATHS_ICON = String.raw`<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><circle cx="5" cy="6" r="2"/><circle cx="19" cy="6" r="2"/><circle cx="5" cy="18" r="2"/><circle cx="19" cy="18" r="2"/><line x1="7" y1="7" x2="10" y2="10"/><line x1="17" y1="7" x2="14" y2="10"/><line x1="7" y1="17" x2="10" y2="14"/><line x1="17" y1="17" x2="14" y2="14"/></svg>`;

defineToolTab({
  id: 'fitness',
  tool: 'fit',
  label: 'Fitness',
  icon: FITNESS_ICON,
  badgeStyle: 'background:rgba(124,160,104,0.15);color:var(--accent-fitness)',
  renderFunctionName: 'renderFitnessTab',
});

defineToolTab({
  id: 'simulation',
  tool: 'sim',
  label: 'Simulation',
  icon: SIMULATION_ICON,
  badgeStyle: 'background:rgba(155,138,165,0.15);color:var(--accent-sim)',
  renderFunctionName: 'renderSimulationTab',
});

defineToolTab({
  id: 'code-paths',
  tool: 'graph',
  label: 'Code Graph',
  icon: CODE_PATHS_ICON,
  badgeStyle: 'background:rgba(196,154,108,0.15);color:var(--accent)',
  renderFunctionName: 'renderCodePathsTab',
});
