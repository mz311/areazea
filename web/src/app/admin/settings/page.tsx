import type { Metadata } from "next";
import { SettingsForm } from "@/components/admin/SettingsForm";
import { PageHeader } from "@/components/ui";

export const metadata: Metadata = { title: "Paramètres" };

export default function Page() {
  return (
    <div>
      <PageHeader title="Paramètres" subtitle="Nom, logo, liens Discord et maintenance." />
      <SettingsForm />
    </div>
  );
}
