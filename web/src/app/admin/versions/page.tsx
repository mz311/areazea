import type { Metadata } from "next";
import { VersionsManager } from "@/components/admin/VersionsManager";
import { PageHeader } from "@/components/ui";

export const metadata: Metadata = { title: "Versions" };

export default function VersionsPage() {
  return (
    <div>
      <PageHeader title="Versions" subtitle="Importez, éditez, publiez et restaurez les versions de la base." />
      <VersionsManager />
    </div>
  );
}
