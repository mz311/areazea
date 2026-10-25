import type { Metadata } from "next";
import { UsersManager } from "@/components/admin/UsersManager";
import { PageHeader } from "@/components/ui";

export const metadata: Metadata = { title: "Utilisateurs" };

export default function Page() {
  return (
    <div>
      <PageHeader title="Utilisateurs" subtitle="Rôles, surcharges de permissions et bannissements." />
      <UsersManager />
    </div>
  );
}
