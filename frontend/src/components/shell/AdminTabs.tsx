// Admin section tabs. Contacts and Sync Issues are Admin workflows, not
// sidebar sections — this bar is how they're reached. (/vendors and
// /contacts render the same screen; only Contacts is listed.)
import React from "react";
import { SectionTabs } from "@/src/components/layout/SectionTabs";

export type AdminTabKey = "settings" | "contacts" | "files" | "sync";

export const AdminTabs: React.FC<{ active: AdminTabKey }> = ({ active }) => (
  <SectionTabs
    testID="admin-tabs"
    active={active}
    tabs={[
      { key: "settings", label: "Site Settings", route: "/(app)/site-admin" },
      { key: "contacts", label: "Contacts", route: "/(app)/contacts" },
      { key: "files", label: "Files & Imports", route: "/(app)/files" },
      { key: "sync", label: "Sync Issues", route: "/(app)/sync-issues" },
    ]}
  />
);
