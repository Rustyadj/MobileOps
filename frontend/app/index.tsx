import { Redirect } from "expo-router";
import { useAuth } from "@/src/context/AuthContext";
import { View, ActivityIndicator } from "react-native";
import { colors } from "@/src/theme";

export default function Index() {
  const { user, loading } = useAuth();
  if (loading) {
    return (
      <View style={{ flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: colors.bg }}>
        <ActivityIndicator color={colors.orange} size="large" />
      </View>
    );
  }
  return <Redirect href={user ? "/(app)" : "/login"} />;
}
