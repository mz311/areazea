/** N'accepte que des chemins relatifs internes (pas d'open-redirect). */
export function safeReturnTo(v: string | null | undefined, fallback = "/download"): string {
  if (!v || !v.startsWith("/") || v.startsWith("//") || v.includes("\\") || /[\u0000-\u001f]/.test(v)) return fallback;
  return v;
}
