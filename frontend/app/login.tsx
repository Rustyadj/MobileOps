import { useState } from "react";
import { View, Text, StyleSheet, KeyboardAvoidingView, Platform, ScrollView, TouchableOpacity } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import * as WebBrowser from "expo-web-browser";
import { Ionicons } from "@expo/vector-icons";
import { useAuth } from "@/src/context/AuthContext";
import { Button, Input, H1 } from "@/src/components/ui";
import { colors, spacing, type as typo, radii } from "@/src/theme";

// Required so mobile WebBrowser auth sessions complete on return.
WebBrowser.maybeCompleteAuthSession();

export default function LoginScreen() {
  const { login, loginWithGoogle } = useAuth();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [googleBusy, setGoogleBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const onSubmit = async () => {
    setErr(null);
    setBusy(true);
    try {
      await login(email.trim(), password);
    } catch (e: any) {
      setErr(e.message || "Login failed");
    } finally {
      setBusy(false);
    }
  };

  const onGoogle = async () => {
    setErr(null);
    setGoogleBusy(true);
    try {
      await loginWithGoogle();
      // On web this will have redirected; on mobile the session_id was already exchanged by AuthContext.
    } catch (e: any) {
      setErr(e?.message || "Google sign-in failed");
    } finally {
      setGoogleBusy(false);
    }
  };

  return (
    <SafeAreaView style={styles.container} edges={["top", "bottom"]}>
      <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} style={{ flex: 1 }}>
        <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
          <View style={styles.brandBlock}>
            <View style={styles.brandMark}>
              <Text style={styles.brandLetter}>C</Text>
            </View>
            <Text style={styles.brandName}>Concrete Form</Text>
            <Text style={styles.brandTagline}>Field operations for ICF contractors</Text>
          </View>

          <View style={styles.form}>
            <H1 style={{ marginBottom: spacing.xs }}>Sign in</H1>
            <Text style={[typo.bodySmall, { marginBottom: spacing.lg }]}>
              Use your team credentials to continue.
            </Text>

            <TouchableOpacity
              style={styles.googleBtn}
              onPress={onGoogle}
              disabled={googleBusy || busy}
              activeOpacity={0.85}
              testID="google-signin-button"
            >
              <Ionicons name="logo-google" size={18} color={colors.ink} />
              <Text style={styles.googleText}>
                {googleBusy ? "Opening Google…" : "Continue with Google"}
              </Text>
            </TouchableOpacity>

            <View style={styles.dividerRow}>
              <View style={styles.dividerLine} />
              <Text style={styles.dividerText}>or sign in with email</Text>
              <View style={styles.dividerLine} />
            </View>

            <Input
              label="Email"
              value={email}
              onChangeText={setEmail}
              autoCapitalize="none"
              keyboardType="email-address"
              autoComplete="email"
              testID="login-email-input"
            />
            <Input
              label="Password"
              value={password}
              onChangeText={setPassword}
              secureTextEntry
              autoComplete="password"
              testID="login-password-input"
            />

            {err ? (
              <View style={styles.errBox} testID="login-error">
                <Text style={{ color: colors.error, fontWeight: "600", fontSize: 13 }}>{err}</Text>
              </View>
            ) : null}

            <Button title="Sign in" onPress={onSubmit} loading={busy} testID="login-submit-button" />
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  scroll: { flexGrow: 1, padding: spacing.lg },
  brandBlock: { alignItems: "center", marginTop: spacing.xl, marginBottom: spacing.xl },
  brandMark: {
    width: 64, height: 64,
    borderRadius: radii.lg,
    backgroundColor: colors.primary,
    alignItems: "center", justifyContent: "center",
    marginBottom: spacing.md,
  },
  brandLetter: { color: "#FFF", fontSize: 32, fontWeight: "700" },
  brandName: { fontSize: 22, fontWeight: "700", color: colors.ink, letterSpacing: -0.3 },
  brandTagline: { marginTop: 4, fontSize: 13, color: colors.inkSecondary },
  form: { paddingTop: spacing.md },
  googleBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 10,
    height: 48,
    borderWidth: 1,
    borderColor: colors.borderStrong,
    borderRadius: radii.md,
    backgroundColor: colors.bg,
    marginBottom: spacing.md,
  },
  googleText: { fontSize: 14, fontWeight: "600", color: colors.ink },
  dividerRow: { flexDirection: "row", alignItems: "center", gap: 10, marginVertical: spacing.md },
  dividerLine: { flex: 1, height: 1, backgroundColor: colors.border },
  dividerText: { fontSize: 11, color: colors.inkMuted, letterSpacing: 0.4, textTransform: "uppercase" },
  errBox: { borderWidth: 1, borderColor: colors.error, backgroundColor: colors.errorSoft, padding: spacing.md, marginBottom: spacing.md, borderRadius: radii.md },
});
