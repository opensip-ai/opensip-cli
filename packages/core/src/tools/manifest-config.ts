/**
 * @fileoverview The serializable, JSON-Schema-shaped config descriptor a tool
 * declares in its static manifest (`ToolManifest.config`) — the COARSE schema
 * the host validates an EXTERNAL tool's config namespace against BEFORE forking
 * its worker (ADR-0054 M4-E, Config semantics).
 *
 * The host must never execute an external tool's Zod schema (Zod schemas are
 * executable code — refinements / transforms / closures — the exact load-time
 * hole ADR-0054 rejects). So an external tool ships a plain-data, draft-07-subset
 * structural descriptor here. The host validates the namespace's TOP-LEVEL shape
 * against it (known keys, primitive types, required/optional, unknown-key
 * rejection) as pure data — no code runs. The tool's real Zod runs LATER, in the
 * worker, after the runtime loads (the deep, authoritative semantic pass).
 *
 * These types live in **core** (beside the `Tool` contract + the manifest).
 * Core must not depend on `@opensip-cli/config` or Zod, so the JSON-Schema shape
 * is declared structurally here as plain data; `@opensip-cli/config` (the
 * composition root's config layer) owns the coarse validator that interprets it.
 */

/**
 * The primitive JSON-Schema `type` values the coarse pass understands. Object
 * and array compose these (`additionalProperties` / `items`). Cross-field
 * refinements, transforms, formats, and `$ref` are deliberately NOT modelled —
 * those are the worker's deep Zod pass, never the host's coarse pass.
 */
export type JsonSchemaPrimitiveType =
  | 'string'
  | 'number'
  | 'integer'
  | 'boolean'
  | 'object'
  | 'array'
  | 'null';

/**
 * A draft-07-subset JSON-Schema node — the plain-data structural shape the
 * coarse pass walks. Only the keywords the coarse pass enforces are modelled
 * (`type`, `properties`, `required`, `additionalProperties`, `items`, `enum`).
 * Everything is optional + serializable; the host treats it strictly as data.
 */
export interface JsonSchemaNode {
  /** The node's primitive type, or a union of allowed types. */
  readonly type?: JsonSchemaPrimitiveType | readonly JsonSchemaPrimitiveType[];
  /** For `type: 'object'`: the known keys and their schemas. */
  readonly properties?: Readonly<Record<string, JsonSchemaNode>>;
  /** For `type: 'object'`: the required keys. */
  readonly required?: readonly string[];
  /**
   * For `type: 'object'`: whether unknown keys are permitted. `false` ⇒ the
   * coarse pass rejects an unknown key (the `.strict()` rule-1 semantics); a
   * schema node permits unknown keys when omitted/`true`.
   */
  readonly additionalProperties?: boolean | JsonSchemaNode;
  /** For `type: 'array'`: the element schema. */
  readonly items?: JsonSchemaNode;
  /** An enum of allowed literal values (coarse membership check). */
  readonly enum?: readonly unknown[];
}

/**
 * The TOP-LEVEL JSON-Schema object descriptor for a tool's config namespace —
 * always an object node (a config block is a keyed map). This is the `schema`
 * field of {@link ToolConfigManifestDescriptor}.
 */
export interface JsonSchemaObject extends JsonSchemaNode {
  readonly type?: 'object';
  readonly properties?: Readonly<Record<string, JsonSchemaNode>>;
}

/**
 * The static, serializable config descriptor a tool declares in its manifest
 * (`ToolManifest.config`). The host validates an EXTERNAL tool's config
 * namespace against `schema` (coarse) before forking; the worker runs the tool's
 * real Zod (deep) after load. Plain serializable data — the host never executes
 * it as code.
 */
export interface ToolConfigManifestDescriptor {
  /** The config namespace this tool owns (its top-level block key in the document). */
  readonly namespace: string;
  /**
   * JSON-Schema (draft-07 subset) for the namespace's TOP-LEVEL structural shape:
   * known keys, primitive types, required/optional, `additionalProperties:false`.
   * COARSE only — NO cross-field refinements/transforms (those are the worker's
   * Zod deep pass). Plain serializable data; the host never executes it as code.
   */
  readonly schema: JsonSchemaObject;
}
