export function hmToMinutes(hm: string): number {
  const [a, b] = hm.split(":");
  const h = Number.parseInt(a ?? "0", 10);
  const m = Number.parseInt(b ?? "0", 10);
  if (!Number.isFinite(h) || !Number.isFinite(m)) return 0;
  return h * 60 + m;
}
