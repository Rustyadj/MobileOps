// Site Admin — brand, logo, and company contact settings. A settings form,
// not a list of entities, so desktop gets a clamped centered two-column
// form instead of a DataTable — consistent with the rest of the app's
// PageHeader/desktopHeader convention.
import { useCallback, useEffect, useState } from "react";
import { View, Text, Image, Alert } from "react-native";
import * as ImagePicker from "expo-image-picker";
import { Screen } from "@/src/components/Screen";
import { Card, Input, Button, SectionLabel, Row } from "@/src/components/ui";
import { PageHeader } from "@/src/components/layout/PageHeader";
import { api } from "@/src/api/client";
import { useAuth } from "@/src/context/AuthContext";
import { useBreakpoint } from "@/src/hooks/use-breakpoint";
import { colors, spacing, type as typo } from "@/src/theme";

type Site = {
  brand_name: string; tagline: string; logo_base64: string; primary_color: string;
  company_address: string; company_phone: string; company_email: string;
};

const blank: Site = { brand_name: "Concrete Form", tagline: "", logo_base64: "", primary_color: "#FF6A00", company_address: "", company_phone: "", company_email: "" };

export default function SiteAdminScreen() {
  const { user } = useAuth();
  const { isShellWide } = useBreakpoint();
  const [site, setSite] = useState<Site>(blank);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try { setSite(await api<Site>("/site")); } catch (e) { console.warn(e); }
  }, []);
  useEffect(() => { load(); }, [load]);

  const pickLogo = async () => {
    const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!perm.granted) { Alert.alert("Permission needed", "Photo library access required."); return; }
    const res = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ["images"],
      base64: true, quality: 0.5, allowsEditing: true,
    });
    if (res.canceled || !res.assets?.[0]?.base64) return;
    const b64 = `data:image/png;base64,${res.assets[0].base64}`;
    setSite((s) => ({ ...s, logo_base64: b64 }));
  };

  const save = async () => {
    if (user?.role !== "admin") { Alert.alert("Admin only", "Only admins can update site settings."); return; }
    setBusy(true);
    try {
      const updated = await api<Site>("/site", { method: "PUT", body: JSON.stringify(site) });
      setSite(updated);
      Alert.alert("Saved", "Site settings updated.");
    } catch (e: any) { Alert.alert("Save failed", e.message); }
    finally { setBusy(false); }
  };

  const desktopHeader = (
    <PageHeader
      title="Site Admin"
      subtitle="Brand · Logo · Company contact"
      actions={
        <Button title="Save Settings" onPress={save} loading={busy} fullWidth={false} style={{ paddingHorizontal: 20, height: 38 }} testID="save-site-btn" />
      }
    />
  );

  return (
    <Screen
      title="Site Admin"
      subtitle="Brand · Logo · Contact"
      back
      scroll={isShellWide ? false : true}
      clampWidth
      desktopHeader={desktopHeader}
      testID="site-admin-screen"
    >
      <View style={isShellWide ? { flex: 1 } : undefined}>
        <View style={isShellWide ? { paddingHorizontal: spacing.xl, paddingBottom: spacing.xl } : undefined}>
          <View style={isShellWide ? { flexDirection: "row", gap: spacing.lg, alignItems: "flex-start" } : undefined}>
            <View style={isShellWide ? { width: 220 } : undefined}>
              <SectionLabel>Logo</SectionLabel>
              <Card style={{ marginBottom: spacing.md, alignItems: "center" }}>
                {site.logo_base64 ? (
                  <Image source={{ uri: site.logo_base64 }} style={{ width: 140, height: 140, marginBottom: spacing.md }} resizeMode="contain" testID="site-logo" />
                ) : (
                  <View style={{ width: 140, height: 140, borderWidth: 2, borderColor: colors.border, borderStyle: "dashed", alignItems: "center", justifyContent: "center", marginBottom: spacing.md }}>
                    <Text style={[typo.label, { color: colors.inkMuted }]}>No logo</Text>
                  </View>
                )}
                <Row style={{ gap: spacing.sm, alignSelf: "stretch" }}>
                  <View style={{ flex: 1 }}><Button title="Upload" onPress={pickLogo} variant="outline" testID="upload-logo-btn" /></View>
                  {site.logo_base64 ? (
                    <View style={{ flex: 1 }}><Button title="Remove" onPress={() => setSite({ ...site, logo_base64: "" })} variant="danger" testID="remove-logo-btn" /></View>
                  ) : null}
                </Row>
              </Card>
            </View>

            <View style={{ flex: 1 }}>
              <SectionLabel>Brand</SectionLabel>
              <Card style={{ marginBottom: spacing.md }}>
                <Input label="Brand Name" value={site.brand_name} onChangeText={(t) => setSite({ ...site, brand_name: t })} testID="site-brand" />
                <Input label="Tagline" value={site.tagline} onChangeText={(t) => setSite({ ...site, tagline: t })} testID="site-tagline" />
              </Card>

              <SectionLabel>Company contact</SectionLabel>
              <Card style={{ marginBottom: spacing.md }}>
                <Input label="Address" value={site.company_address} onChangeText={(t) => setSite({ ...site, company_address: t })} testID="site-address" />
                <Row style={{ gap: spacing.md }}>
                  <View style={{ flex: 1 }}><Input label="Phone" value={site.company_phone} onChangeText={(t) => setSite({ ...site, company_phone: t })} keyboardType="phone-pad" mono testID="site-phone" /></View>
                  <View style={{ flex: 1 }}><Input label="Email" value={site.company_email} onChangeText={(t) => setSite({ ...site, company_email: t })} keyboardType="email-address" autoCapitalize="none" testID="site-email" /></View>
                </Row>
              </Card>

              {!isShellWide ? <Button title="Save Settings" onPress={save} loading={busy} testID="save-site-btn" /> : null}
            </View>
          </View>
        </View>
      </View>
    </Screen>
  );
}
