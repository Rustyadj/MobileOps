import { Stack, useRouter, useSegments } from "expo-router";
import * as SplashScreen from "expo-splash-screen";
import * as Notifications from "expo-notifications";
import * as Linking from "expo-linking";
import { Platform } from "react-native";
import { useEffect } from "react";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { StatusBar } from "expo-status-bar";

import { useIconFonts } from "@/src/hooks/use-icon-fonts";
import { AuthProvider, useAuth } from "@/src/context/AuthContext";

// Keep the native splash visible until icon fonts register.
SplashScreen.preventAutoHideAsync();

// Push notification setup at module scope (native only).
if (Platform.OS !== "web") {
  Notifications.setNotificationHandler({
    handleNotification: async () => ({
      shouldShowAlert: true,
      shouldPlaySound: true,
      shouldSetBadge: false,
      shouldShowBanner: true,
      shouldShowList: true,
    }),
  });
}

if (Platform.OS === "android") {
  Notifications.setNotificationChannelAsync("default", {
    name: "Default",
    importance: Notifications.AndroidImportance.MAX,
    sound: "default",
  });
}

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
  const router = useRouter();

  useEffect(() => {
    if (Platform.OS === "web") return;
    const sub = Notifications.addNotificationResponseReceivedListener((resp) => {
      const data: any = resp.notification.request.content.data || {};
      const url = data.deeplink || data.action_url;
      if (!url) return;
      if (String(url).startsWith("http")) Linking.openURL(url);
      else router.push(url);
    });
    Notifications.getLastNotificationResponseAsync().then((resp) => {
      if (!resp) return;
      const data: any = resp.notification.request.content.data || {};
      const url = data.deeplink || data.action_url;
      if (!url) return;
      if (String(url).startsWith("http")) Linking.openURL(url);
      else router.push(url);
    });
    return () => sub.remove();
  }, [router]);

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
