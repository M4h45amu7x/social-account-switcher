// A type-only mention disappears at runtime; Biome still rejects it in src/, the scanner does not.
export type Version = string;
export const label = (v: Version): string => `v${v}`;
