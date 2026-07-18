import { posix } from "node:path";

import { listAgentGuidanceTargetSpecs } from "./agent-guidance.js";
import {
  INIT_AUTHORED_PLAN_CAPS,
  authoredPlanFailure,
  caseFoldPath,
  compareUtf8,
  normalizeProjectRelativePath,
} from "./init-authored-plan-types.js";

import type {
  BuildInitAuthoredPlanInput,
  InitAuthoredTargetType,
  RenderedInitToolScaffold,
} from "./init-authored-plan-types.js";

export interface InitAuthoredDesiredTarget {
  readonly type: InitAuthoredTargetType;
  readonly content?: string;
}

function safeSegment(value: string, field: string): string {
  if (
    value.length === 0 ||
    value.includes("/") ||
    value.includes("\\") ||
    value === "." ||
    value === ".." ||
    value !== value.normalize("NFC")
  ) {
    authoredPlanFailure(`${field} must be one safe path segment`);
  }
  return value;
}

type AddTarget = (path: string, entry: InitAuthoredDesiredTarget) => void;

function scaffoldKinds(
  scaffold: RenderedInitToolScaffold,
  toolIndex: number,
): ReadonlySet<string> {
  const kinds = new Set<string>();
  const foldedKinds = new Set<string>();
  for (const [kindIndex, rawKind] of scaffold.layout.userSubdirs.entries()) {
    const kind = safeSegment(
      rawKind,
      `tools[${String(toolIndex)}].userSubdirs[${String(kindIndex)}]`,
    );
    if (kinds.has(kind) || foldedKinds.has(caseFoldPath(kind))) {
      authoredPlanFailure(
        `Tool ${scaffold.identity.name} has duplicate user directories`,
      );
    }
    kinds.add(kind);
    foldedKinds.add(caseFoldPath(kind));
  }
  return kinds;
}

function addToolDirectories(
  scaffold: RenderedInitToolScaffold,
  domain: string,
  kinds: ReadonlySet<string>,
  domains: Map<string, string>,
  desired: ReadonlyMap<string, InitAuthoredDesiredTarget>,
  add: AddTarget,
): void {
  if (!scaffold.createsExampleDirectories || kinds.size === 0) return;
  const domainFolded = caseFoldPath(domain);
  const priorDomain = domains.get(domainFolded);
  if (priorDomain !== undefined) {
    authoredPlanFailure(
      `Tool ${scaffold.identity.name} shares authored domain '${domain}' with ${priorDomain}`,
    );
  }
  domains.set(domainFolded, scaffold.identity.name);
  if (!desired.has("opensip-cli")) add("opensip-cli", { type: "directory" });
  const domainPath = `opensip-cli/${domain}`;
  add(domainPath, { type: "directory" });
  for (const kind of kinds) {
    add(`${domainPath}/${kind}`, { type: "directory" });
  }
}

function addToolExamples(
  scaffold: RenderedInitToolScaffold,
  toolIndex: number,
  domain: string,
  kinds: ReadonlySet<string>,
  add: AddTarget,
): void {
  const stableIds = new Set<string>();
  for (const [exampleIndex, example] of scaffold.examples.entries()) {
    if (!kinds.has(example.kind)) {
      authoredPlanFailure(
        `tools[${String(toolIndex)}].examples[${String(exampleIndex)}].kind is undeclared`,
      );
    }
    const filename = safeSegment(
      example.filename,
      `tools[${String(toolIndex)}].examples[${String(exampleIndex)}].filename`,
    );
    const stableIdBytes = Buffer.byteLength(example.stableId, "utf8");
    if (
      example.stableId.length === 0 ||
      stableIdBytes > INIT_AUTHORED_PLAN_CAPS.maxIdentityBytes ||
      stableIds.has(example.stableId)
    ) {
      authoredPlanFailure(
        `Tool example ${filename} has an invalid or duplicate stable id`,
      );
    }
    stableIds.add(example.stableId);
    add(`opensip-cli/${domain}/${example.kind}/${filename}`, {
      type: "file",
      content: example.content,
    });
  }
}

export function collectToolDesiredEntries(
  scaffolds: readonly RenderedInitToolScaffold[],
): ReadonlyMap<string, InitAuthoredDesiredTarget> {
  const desired = new Map<string, InitAuthoredDesiredTarget>();
  const folded = new Map<string, string>();
  const domains = new Map<string, string>();
  const add = (path: string, entry: InitAuthoredDesiredTarget): void => {
    const normalized = normalizeProjectRelativePath(path);
    const prior = folded.get(caseFoldPath(normalized));
    if (prior !== undefined) {
      authoredPlanFailure(
        `duplicate or case-folded Tool target '${normalized}' conflicts with '${prior}'`,
      );
    }
    folded.set(caseFoldPath(normalized), normalized);
    desired.set(normalized, entry);
  };

  for (const [toolIndex, scaffold] of scaffolds.entries()) {
    const domain = safeSegment(
      scaffold.layout.domain,
      `tools[${String(toolIndex)}].domain`,
    );
    if (!scaffold.createsExampleDirectories && scaffold.examples.length > 0) {
      authoredPlanFailure(
        `Tool ${scaffold.identity.name} rendered examples without a hook`,
      );
    }
    const kinds = scaffoldKinds(scaffold, toolIndex);
    addToolDirectories(scaffold, domain, kinds, domains, desired, add);
    addToolExamples(scaffold, toolIndex, domain, kinds, add);
  }
  return desired;
}

export function collectInitAuthoredTargetPaths(
  mode: BuildInitAuthoredPlanInput["mode"],
  toolScaffolds: readonly RenderedInitToolScaffold[],
): readonly string[] {
  const paths = new Set<string>(["opensip-cli.config.yml", ".gitignore"]);
  for (const spec of listAgentGuidanceTargetSpecs()) {
    paths.add(normalizeProjectRelativePath(spec.relativePath));
    const parent = posix.dirname(spec.relativePath);
    if (parent !== ".") paths.add(normalizeProjectRelativePath(parent));
  }
  if (mode !== "refresh") {
    for (const path of collectToolDesiredEntries(toolScaffolds).keys())
      paths.add(path);
  }
  return [...paths].sort(compareUtf8);
}
