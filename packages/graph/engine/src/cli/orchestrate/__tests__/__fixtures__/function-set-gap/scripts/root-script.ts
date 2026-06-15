// A root-level script OUTSIDE packages/ entirely. discoverPolyglotUnits
// only walks <root>/packages/**, so this file is in NO workspace unit and
// the sharded build never discovers it (cause bucket (a)).
export function rootScriptSubject(): number {
  return 5;
}
