/** A JSON value accepted by an evaluation tool invocation. */
export type JsonValue =
  boolean | null | number | string | readonly JsonValue[] | { readonly [key: string]: JsonValue };

/** An immutable JSON object used for bounded tool arguments and summaries. */
export type JsonObject = Readonly<Record<string, JsonValue>>;

/** One side of a paired evaluation: native control or OpenSIP evidence. */
export type Arm = 'control' | 'opensip';

/**
 * A run leg owns an independent answer state. `main` is used by ordinary
 * tasks; mutation tasks use the three explicit edit-loop legs.
 */
export type RunLeg = 'main' | 'post-edit' | 'pre-edit' | 'recovery';

/** A normalized project-relative file observation. */
export interface FileFact {
  readonly kind: 'file';
  readonly path: string;
  readonly role?: string;
}

/** A normalized symbol observation with optional source coordinates. */
export interface SymbolFact {
  readonly kind: 'symbol';
  readonly name: string;
  readonly filePath?: string;
  readonly line?: number;
  readonly package?: string;
}

/** A machine-reusable identity returned by a code-intelligence surface. */
export interface SymbolHandleFact {
  readonly kind: 'symbol-handle';
  readonly symbolId: string;
  readonly bodyHash?: string;
  readonly column?: number;
  readonly filePath?: string;
  readonly inTestFile?: boolean;
  readonly line?: number;
  readonly name?: string;
  readonly package?: string;
  readonly qualifiedName?: string;
}

/** A non-callable declaration identity returned by declaration graph reads. */
export interface DeclarationHandleFact {
  readonly kind: 'declaration-handle';
  readonly declarationId: string;
  readonly column?: number;
  readonly declarationKind?: string;
  readonly filePath?: string;
  readonly line?: number;
  readonly name?: string;
  readonly package?: string;
}

/** A normalized package-identity observation. */
export interface PackageFact {
  readonly kind: 'package';
  readonly name: string;
}

/** A labeled textual observation such as a package-manager identity. */
export interface TextFact {
  readonly kind: 'text';
  readonly label: string;
  readonly value: string;
}

/** An executable command observation with an optional semantic purpose. */
export interface CommandFact {
  readonly kind: 'command';
  readonly command: string;
  readonly purpose?: string;
}

/** A labeled numeric observation used for topology and inventory assertions. */
export interface CountFact {
  readonly kind: 'count';
  readonly label: string;
  readonly value: number;
}

/** Provenance metadata supporting a normalized subject observation. */
export interface EvidenceFact {
  readonly kind: 'evidence';
  readonly attribution?: string;
  readonly column?: number;
  readonly subject: string;
  readonly confidence?: string;
  readonly evidenceKind?: string;
  readonly filePath?: string;
  readonly line?: number;
  readonly resolution?: string;
  readonly targetHashes?: readonly string[];
}

/** A normalized catalog-freshness observation. */
export interface FreshnessFact {
  readonly kind: 'freshness';
  readonly fresh: boolean;
  readonly catalogIdentity?: string;
  readonly reasonCode?: string;
  readonly verification?: 'complete' | 'missing' | 'partial';
}

/** A normalized answer atom. Facts contain no raw tool response. */
export type AnswerFact =
  | CommandFact
  | CountFact
  | DeclarationHandleFact
  | EvidenceFact
  | FileFact
  | FreshnessFact
  | PackageFact
  | SymbolFact
  | SymbolHandleFact
  | TextFact;

/**
 * Expected facts are partial on purpose. A task can assert a stable semantic
 * identity without coupling itself to every piece of metadata a tool returns.
 */
export type AnswerFactPattern =
  | ({ readonly kind: 'command' } & Partial<Omit<CommandFact, 'kind'>>)
  | ({
      readonly kind: 'count';
      readonly maximum?: number;
      readonly minimum?: number;
    } & Partial<Omit<CountFact, 'kind'>>)
  | ({ readonly kind: 'declaration-handle' } & Partial<Omit<DeclarationHandleFact, 'kind'>>)
  | ({
      readonly kind: 'evidence';
      readonly minimumConfidence?: 'high' | 'low' | 'medium';
    } & Partial<Omit<EvidenceFact, 'kind'>>)
  | ({ readonly kind: 'file' } & Partial<Omit<FileFact, 'kind'>>)
  | ({ readonly kind: 'freshness' } & Partial<Omit<FreshnessFact, 'kind'>>)
  | ({ readonly kind: 'package' } & Partial<Omit<PackageFact, 'kind'>>)
  | ({ readonly kind: 'symbol' } & Partial<Omit<SymbolFact, 'kind'>>)
  | ({ readonly kind: 'symbol-handle' } & Partial<Omit<SymbolHandleFact, 'kind'>>)
  | ({ readonly kind: 'text' } & Partial<Omit<TextFact, 'kind'>>);

/** Expected and forbidden facts scoped to one independent run leg. */
export interface ScopedAnswerAssertions {
  readonly leg: RunLeg;
  readonly mustExclude?: readonly AnswerFactPattern[];
  readonly mustInclude?: readonly AnswerFactPattern[];
}

/** Declares the post-edit and optional recovery legs for staleness scoring. */
export interface StalenessAssertion {
  /** The scoped assertions for this leg describe the post-mutation truth. */
  readonly postEditLeg: 'post-edit';
  /** Optional bounded recovery assertions, scored separately from primary cost. */
  readonly recoveryLeg?: 'recovery';
}

/** The complete semantic answer contract for a gold task. */
export interface AnswerAssertions {
  /** Ordinary-task assertions. They apply to the `main` leg. */
  readonly mustExclude?: readonly AnswerFactPattern[];
  readonly mustInclude?: readonly AnswerFactPattern[];
  readonly scoped?: readonly ScopedAnswerAssertions[];
  readonly staleness?: StalenessAssertion;
}

/** A fact plus the step and leg provenance needed for safe argument binding. */
export interface FactObservation {
  readonly fact: AnswerFact;
  readonly leg: RunLeg;
  readonly ordinal: number;
  readonly stepId: string;
}

/** Fact fields that a later strategy step may bind into its arguments. */
export type BindableFactField =
  | 'bodyHash'
  | 'catalogIdentity'
  | 'command'
  | 'declarationId'
  | 'filePath'
  | 'label'
  | 'line'
  | 'name'
  | 'package'
  | 'path'
  | 'qualifiedName'
  | 'reasonCode'
  | 'resolution'
  | 'subject'
  | 'symbolId'
  | 'value';

/**
 * A declarative binding is the only response-dependent argument mechanism.
 * It can observe prior normalized facts, but receives neither the task nor its
 * assertions, which keeps ground truth out of argument resolution.
 */
export interface FactBinding {
  readonly $fact: {
    readonly field: BindableFactField;
    readonly leg?: RunLeg;
    readonly match: AnswerFactPattern;
    readonly select?: 'first' | 'last' | 'only';
    readonly stepId?: string;
  };
}

/** A JSON-compatible argument value that may contain declarative fact bindings. */
export type ArgumentTemplateValue =
  | boolean
  | FactBinding
  | null
  | number
  | string
  | readonly ArgumentTemplateValue[]
  | { readonly [key: string]: ArgumentTemplateValue };

/** The unresolved argument object declared by a strategy step. */
export type ArgumentTemplate = Readonly<Record<string, ArgumentTemplateValue>>;

/** Converts one tool payload into durable, normalized answer facts. */
export type ResponseExtractor = (payload: unknown) => readonly AnswerFact[];

/** Semantic closure needed before a response can support negative proof. */
export interface ProofClosureAssessment {
  readonly domainExhausted: boolean;
  readonly projectionComplete: boolean;
  readonly reasonCodes: readonly string[];
}

/** Classifies response-to-fact projection and continuation-domain closure. */
export type ProofClosureAssessor = (payload: unknown) => ProofClosureAssessment;

/** Whether this step's response projection can constrain a later absence proof. */
export type ProofRelevance = 'irrelevant' | 'projection';

/** One declarative tool invocation in an evaluation strategy. */
export interface StrategyStep {
  readonly arguments: ArgumentTemplate;
  readonly assessProofClosure?: ProofClosureAssessor;
  /** Single source for the strategy's non-empty response contract. */
  readonly expectedNonEmpty?: boolean;
  readonly extract: ResponseExtractor;
  readonly id: string;
  readonly leg?: RunLeg;
  /** Negative fact domains this step can prove when its evidence is exhaustive. */
  readonly provesAbsence?: readonly AnswerFactPattern[];
  /** Defaults to `projection`; independent setup/state steps must opt out explicitly. */
  readonly proofRelevance?: ProofRelevance;
  readonly rationale: string;
  readonly tool: string;
}

/** A strategy step whose fact bindings and response contract are fully resolved. */
export interface ResolvedStrategyStep extends Omit<StrategyStep, 'arguments' | 'expectedNonEmpty'> {
  readonly arguments: JsonObject;
  readonly expectedNonEmpty: boolean;
}

/** An ordered, versioned strategy for one evaluation arm. */
export interface ArmStrategy {
  readonly arm: Arm;
  readonly steps: readonly StrategyStep[];
  readonly version: string;
}

/** One contained workspace mutation used by a staleness evaluation. */
export type EditOperation =
  | { readonly content: string; readonly kind: 'append'; readonly path: string }
  | { readonly kind: 'delete'; readonly path: string }
  | { readonly content: string; readonly kind: 'write'; readonly path: string };

/** An ordered set of contained edits applied to a disposable fixture copy. */
export interface EditScript {
  readonly operations: readonly EditOperation[];
}

/** Mutation and follow-up strategies for a bounded stale-catalog experiment. */
export interface StalenessSpec {
  readonly edit: EditScript;
  readonly postEditSteps: Readonly<Record<Arm, readonly StrategyStep[]>>;
  readonly recoverySteps?: Readonly<Record<Arm, readonly StrategyStep[]>>;
}

/** A frozen evaluation task with shared truth and paired arm strategies. */
export interface GoldTask {
  readonly assertions: AnswerAssertions;
  readonly fixture: string;
  readonly id: string;
  readonly question: string;
  readonly staleness?: StalenessSpec;
  readonly strategies: Readonly<Record<Arm, ArmStrategy>>;
  readonly tags?: readonly string[];
}
