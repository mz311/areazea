import { route } from "@/lib/api";
import { listPublished } from "@/lib/versions";

export const runtime = "nodejs";

export const GET = route({ rate: { name: "pub-updates", limit: 60, windowMs: 60_000 } }, async () => {
  const versions = await listPublished();
  return {
    versions: versions
      .filter((v) => v.minRole === "MEMBER" && v.channel === "STABLE")
      .map((v) => ({
        version: v.version,
        title: v.title,
        summary: v.summary,
        publishedAt: v.publishedAt,
        isCurrent: v.isCurrent,
        changes: v.changes.map((c) => ({ type: c.type, text: c.text, imageId: c.imageId })),
      })),
  };
});
