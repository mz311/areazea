export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0 o";
  const units = ["o", "Ko", "Mo", "Go", "To"];
  const i = Math.min(units.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  const v = n / 1024 ** i;
  return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

export const formatDate = (d: Date | string | null | undefined) =>
  d ? new Date(d).toLocaleDateString("fr-FR", { day: "2-digit", month: "long", year: "numeric" }) : "—";

export const formatDateTime = (d: Date | string | null | undefined) =>
  d ? new Date(d).toLocaleString("fr-FR", { dateStyle: "short", timeStyle: "short" }) : "—";

export function timeAgo(d: Date | string): string {
  const s = Math.max(1, Math.floor((Date.now() - new Date(d).getTime()) / 1000));
  const t: [number, string][] = [[31536000, "an"], [2592000, "mois"], [86400, "j"], [3600, "h"], [60, "min"]];
  for (const [sec, label] of t) if (s >= sec) return `il y a ${Math.floor(s / sec)} ${label}${label === "an" && s >= 2 * sec ? "s" : ""}`;
  return "à l'instant";
}
