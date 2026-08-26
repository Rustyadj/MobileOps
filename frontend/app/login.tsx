import { useState } from "react";
import { Redirect } from "expo-router";
import { View, Text, StyleSheet, KeyboardAvoidingView, Platform, ScrollView, TouchableOpacity } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useAuth } from "@/src/context/AuthContext";
import { Button, Input, H1 } from "@/src/components/ui";
import { colors, spacing, type as typo, radii } from "@/src/theme";

export default function LoginScreen() {
  const { user, login, signup } = useAuth();
  const [mode, setMode] = useState<"signin" | "signup">("signin");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [inviteCode, setInviteCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const onSubmit = async () => {
    setErr(null);
    const cleanEmail = email.trim().toLowerCase();
    if (mode === "signup") {
      if (name.trim().length < 2) {
        setErr("Enter your full name.");
        return;
      }
      if (password.length < 8) {
        setErr("Password must be at least 8 characters.");
        return;
      }
      if (password !== confirmPassword) {
        setErr("Passwords do not match.");
        return;
      }
      if (!inviteCode.trim()) {
        setErr("Enter your team invite code.");
        return;
      }
    }
    setBusy(true);
    try {
      if (mode === "signup") {
        await signup(name.trim(), cleanEmail, password, inviteCode);
      } else {
        await login(cleanEmail, password);
      }
    } catch (e: any) {
      setErr(e.message || (mode === "signup" ? "Account creation failed" : "Login failed"));
    } finally {
      setBusy(false);
    }
  };

  const toggleMode = () => {
    setMode((current) => current === "signin" ? "signup" : "signin");
    setErr(null);
    setPassword("");
    setConfirmPassword("");
    setInviteCode("");
  };

  if (user) return <Redirect href="/(app)" />;

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
            <H1 style={{ marginBottom: spacing.xs }}>
              {mode === "signup" ? "Create your account" : "Sign in"}
            </H1>
            <Text style={[typo.bodySmall, { marginBottom: spacing.lg }]}>
              {mode === "signup"
                ? "Use your work email and team invite code to get started."
                : "Use your team credentials to continue."}
            </Text>

            {mode === "signup" ? (
              <Input
                label="Full name"
                value={name}
                onChangeText={setName}
                autoCapitalize="words"
                autoComplete="name"
                textContentType="name"
                testID="register-name-input"
              />
            ) : null}
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
              autoComplete={mode === "signup" ? "new-password" : "current-password"}
              testID="login-password-input"
            />

            {mode === "signup" ? (
              <>
                <Input
                  label="Confirm password"
                  value={confirmPassword}
                  onChangeText={setConfirmPassword}
                  secureTextEntry
                  autoComplete="new-password"
                  testID="register-confirm-password-input"
                />
                <Input
                  label="Team invite code"
                  value={inviteCode}
                  onChangeText={setInviteCode}
                  autoCapitalize="none"
                  autoCorrect={false}
                  testID="register-invite-code-input"
                />
              </>
            ) : null}

            {err ? (
              <View style={styles.errBox} testID="login-error">
                <Text style={{ color: colors.error, fontWeight: "600", fontSize: 13 }}>{err}</Text>
              </View>
            ) : null}

            <Button
              title={mode === "signup" ? "Create account" : "Sign in"}
              onPress={onSubmit}
              loading={busy}
              testID={mode === "signup" ? "register-submit-button" : "login-submit-button"}
            />

            <TouchableOpacity
              onPress={toggleMode}
              disabled={busy}
              style={styles.modeToggle}
              testID="auth-mode-toggle"
            >
              <Text style={styles.modeToggleText}>
                {mode === "signup" ? "Already have an account? " : "New to Concrete Form? "}
                <Text style={styles.modeToggleAction}>
                  {mode === "signup" ? "Sign in" : "Create account"}
                </Text>
              </Text>
            </TouchableOpacity>
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  scroll: { flexGrow: 1, padding: spacing.lg, width: "100%", maxWidth: 480, alignSelf: "center" },
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
  errBox: { borderWidth: 1, borderColor: colors.error, backgroundColor: colors.errorSoft, padding: spacing.md, marginBottom: spacing.md, borderRadius: radii.md },
  modeToggle: { alignItems: "center", paddingVertical: spacing.lg },
  modeToggleText: { fontSize: 14, color: colors.inkSecondary },
  modeToggleAction: { color: colors.primary, fontWeight: "700" },
});
