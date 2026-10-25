import type { Metadata } from "next";
import { AnnouncementsManager } from "@/components/admin/AnnouncementsManager";
import { PageHeader } from "@/components/ui";

export const metadata: Metadata = { title: "Annonces" };

export default function Page() {
  return (
    <div>
      <PageHeader title="Annonces" subtitle="Communiquez avec la communauté, sur le site et sur Discord." />
      <AnnouncementsManager />
    </div>
  );
}
