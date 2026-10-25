import type { Metadata } from "next";
import { VersionEditor } from "@/components/admin/VersionEditor";

export const metadata: Metadata = { title: "Éditer une version" };

export default async function EditVersion({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <VersionEditor id={id} />;
}
