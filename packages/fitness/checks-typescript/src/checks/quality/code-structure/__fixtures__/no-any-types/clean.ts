export function identity<T>(value: T): T {
  return value
}

// Contains the substring `any` inside identifiers only — the superset
// pre-filter admits this file, and the AST pass must still report it clean.
export interface Company {
  readonly companyName: string
}

export function manyCompanies(companies: readonly Company[]): number {
  return companies.length
}
