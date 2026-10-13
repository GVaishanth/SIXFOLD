let counter = 0;

/** Monotonic id generator for pooled objects, runs and effect instances. */
export function nextId(prefix = 'id'): string {
  counter += 1;
  return `${prefix}_${counter.toString(36)}`;
}

export function resetIdCounter(): void {
  counter = 0;
}
