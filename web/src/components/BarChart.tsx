/** Histogramme SVG sans dépendance (téléchargements par jour). */
export function BarChart({ data }: { data: { day: string; n: number }[] }) {
  const max = Math.max(1, ...data.map((d) => d.n));
  const W = 720;
  const H = 180;
  const bw = W / data.length;
  return (
    <svg viewBox={`0 0 ${W} ${H + 24}`} className="w-full" role="img" aria-label="Téléchargements des 30 derniers jours">
      <defs>
        <linearGradient id="bar" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#a66bff" />
          <stop offset="1" stopColor="#5a16bd" />
        </linearGradient>
      </defs>
      {[0.25, 0.5, 0.75, 1].map((p) => (
        <line key={p} x1="0" x2={W} y1={H - H * p} y2={H - H * p} stroke="rgba(255,255,255,.06)" />
      ))}
      {data.map((d, i) => {
        const h = (d.n / max) * (H - 8);
        return (
          <g key={d.day}>
            <rect x={i * bw + 3} y={H - h} width={Math.max(2, bw - 6)} height={Math.max(h, d.n ? 2 : 0)} rx="3" fill="url(#bar)">
              <title>{`${d.day} : ${d.n}`}</title>
            </rect>
            {i % 5 === 0 && (
              <text x={i * bw + bw / 2} y={H + 16} textAnchor="middle" fontSize="10" fill="#71717a">
                {d.day.slice(5)}
              </text>
            )}
          </g>
        );
      })}
    </svg>
  );
}
