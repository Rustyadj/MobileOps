import { Stack, useRouter, useSegments } from "expo-router";
import * as SplashScreen from "expo-splash-screen";
import { useEffect } from "react";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { StatusBar } from "expo-status-bar";

import { useIconFonts } from "@/src/hooks/use-icon-fonts";
import { AuthProvider, useAuth } from "@/src/context/AuthContext";

// Keep the native splash visible until icon fonts register.
SplashScreen.preventAutoHideAsync();

function AuthGate() {
  const { user, loading } = useAuth();
  const segments = useSegments();
  const router = useRouter();

  useEffect(() => {
    if (loading) return;
    const segArr: string[] = segments as unknown as string[];
    const inAuthGroup = segArr[0] === "(app)";
    if (!user && inAuthGroup) {
      router.replace("/login");
    } else if (user && (segArr[0] === "login" || segArr.length === 0)) {
      router.replace("/(app)");
    }
  }, [user, loading, segments, router]);

  return null;
}

function RootInner() {
  return (
    <>
      <AuthGate />
      <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: "#FFFFFF" } }} />
    </>
  );
}

export default function RootLayout() {
  const [loaded, error] = useIconFonts();

  useEffect(() => {
    if (loaded || error) SplashScreen.hideAsync();
  }, [loaded, error]);

  if (!loaded && !error) return null;

  return (
    <SafeAreaProvider>
      <StatusBar style="dark" />
      <AuthProvider>
        <RootInner />
      </AuthProvider>
    </SafeAreaProvider>
  );
}
