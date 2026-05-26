# 01 — Architecture audit (per package)

**Cadence:** Per minor release / quarterly, or after any large refactor touching the target package.
**Mode:** Single-pass (no `/loop`). Reads the whole package, writes a report.
**Output:** `docs/plans/architecture/yyyy-mm-dd-architecture-<service-or-package-name>.md`

---

## Prompt

Read the entire "service/package" module and perform a software
architecture patterns audit. Your primary goal is to evaluate correctness
of usage for SOLID principles and Gang of Four design patterns. Determine
whether patterns and principles already present in the code are being used
correctly, appropriately, and consistently. Look for violations such as
overly coupled classes or modules, unclear responsibility boundaries,
misuse of inheritance vs composition, weak abstractions, leaky interfaces,
brittle conditional logic that should be polymorphic, or unnecessary
pattern complexity. As a secondary goal, identify high-value opportunities
to introduce appropriate design patterns where they would materially
improve the architecture. Do not recommend patterns unless there is a
clear benefit. For every finding, include: the relevant files and code
examples, the principle or pattern involved, whether the current usage is
correct or problematic, why it matters for maintainability and evolution
of the system, and a specific recommendation. Prioritize actionable
findings over theoretical commentary. Write your findings in
`docs/plans/architecture/yyyy-mm-dd-architecture-<service name>.md`.
