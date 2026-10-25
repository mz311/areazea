import type { Metadata } from "next";
import { AuditViewer } from "@/components/admin/AuditViewer";
import { PageHeader } from "@/components/ui";

export const metadata: Metadata = { title: "Journal d'audit" };

export default function Page() {
  return (
    <div>
      <PageHeader title="Journal d'audit" subtitle="Toutes les actions des administrateurs." />
      <AuditViewer />
    </div>
  );
}
