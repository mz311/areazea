/* eslint-disable @next/next/no-img-element */
export function Logo({ logoUrl, size = 40 }: { logoUrl?: string; size?: number }) {
  if (logoUrl) {
    return <img src={logoUrl} alt="" width={size} height={size} className="rounded-xl object-contain" style={{ width: size, height: size }} />;
  }
  return (
    <svg width={size} height={size} viewBox="0 0 40 40" aria-hidden>
      <defs>
        <linearGradient id="lg" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#c4a1ff" />
          <stop offset="1" stopColor="#7020e6" />
        </linearGradient>
      </defs>
      <rect x="2" y="2" width="36" height="36" rx="10" fill="#10101c" stroke="url(#lg)" strokeWidth="2" />
      <path d="M12 27 20 11l8 16h-5l-3-6-3 6z" fill="url(#lg)" />
    </svg>
  );
}
