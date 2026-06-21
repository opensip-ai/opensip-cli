/**
 * Structural types for the vendored Cytoscape runtime (L4 migration).
 *
 * The Code Graph "Visualization" view renders with the vendored `cytoscape`
 * UMD global + the `cytoscape-dagre` layout extension (both inlined ahead of
 * the bundle by `dashboardCytoscapeVendorJs()`). The bundle stays decoupled
 * from the real `cytoscape` types (the client `tsconfig` runs `types: []` and
 * we don't want a build-time dependency on the renderer), so these are minimal
 * structural mirrors — only the slice of the Cytoscape API the view actually
 * touches.
 *
 * This is a type-only module (no runtime exports); esbuild erases it entirely.
 */

/** A Cytoscape graph element (node or edge) — the operations the view uses. */
export interface CyElement {
  id(): string;
  data(key: string): unknown;
  addClass(name: string): CyElement;
  removeClass(name: string): CyElement;
  source(): CyElement;
  target(): CyElement;
}

/** A Cytoscape collection of elements (the result of `nodes()`, `edges()`, …). */
export interface CyCollection {
  readonly length: number;
  forEach(fn: (ele: CyElement) => void): void;
  map<T>(fn: (ele: CyElement) => T): T[];
  removeClass(name: string): CyCollection;
  addClass(name: string): CyCollection;
  union(other: CyCollection | CyElement): CyCollection;
  incomers(selector: string): CyCollection;
  outgoers(selector: string): CyCollection;
}

/** A Cytoscape layout handle. */
export interface CyLayout {
  run(): void;
}

/** The Cytoscape core instance returned by `cytoscape({...})`. */
export interface CyCore {
  elements(): CyCollection;
  nodes(): CyCollection;
  edges(): CyCollection;
  collection(): CyCollection;
  getElementById(id: string): CyCollection;
  batch(fn: () => void): void;
  layout(options: Record<string, unknown>): CyLayout;
  on(
    event: string,
    selectorOrHandler: string | ((evt: CyEvent) => void),
    handler?: (evt: CyEvent) => void,
  ): void;
  center(eles: CyCollection): void;
  fit(eles?: CyCollection, padding?: number): void;
  resize(): void;
}

/** A Cytoscape event (`tap`, …). */
export interface CyEvent {
  target: CyElement | CyCore;
}

/** The `cytoscape` global factory + its `use(extension)` registrar. */
export interface CytoscapeFactory {
  (options: Record<string, unknown>): CyCore;
  use(extension: unknown): void;
  /** Internal guard flag we set so the dagre layout registers exactly once. */
  __gvDagreRegistered?: boolean;
}
