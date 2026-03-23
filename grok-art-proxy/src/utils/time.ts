export function nowMs(): number {
  return Date.now();
}

export function formatTime(ms: number): string {
  return new Date(ms).toISOString();
}
