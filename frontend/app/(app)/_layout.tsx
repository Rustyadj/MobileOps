import { Redirect, Stack } from "expo-router";
import { useAuth } from "@/src/context/AuthContext";
import { AppShell } from "@/src/components/shell/AppShell";

export default function AppLayout() {
  const { user, loading } = useAuth();
  if (loading) return null;
  if (!user) return <Redirect href="/login" />;
  return (
    <AppShell>
      <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: "#FFFFFF" } }} />
    </AppShell>
  );
}
