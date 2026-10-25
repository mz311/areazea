/* eslint-disable @next/next/no-img-element */
import { Badge } from "./ui";

export function ChangeList({ changes }: { changes: { type: string; text: string; imageId: string | null }[] }) {
  if (!changes.length) return <p className="text-sm text-zinc-500">Aucun détail pour cette version.</p>;
  return (
    <ul className="space-y-3">
      {changes.map((c, i) => (
        <li key={i} className="flex flex-col gap-2">
          <div className="flex items-start gap-3">
            <span className="mt-0.5 w-[104px] shrink-0">
              <Badge kind={c.type} />
            </span>
            <span className="text-zinc-200">{c.text}</span>
          </div>
          {c.imageId && (
            <img src={`/api/media/${c.imageId}`} alt="" loading="lazy" className="ml-0 max-h-72 w-auto max-w-full rounded-xl border border-white/10 sm:ml-[116px]" />
          )}
        </li>
      ))}
    </ul>
  );
}
