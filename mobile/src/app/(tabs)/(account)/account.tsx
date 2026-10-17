import React from "react";
import { Alert, Linking, StyleSheet, Text } from "react-native";
import Constants from "expo-constants";
import { auth, currentSession } from "@/lib/sb";
import { useApp } from "@/lib/app";
import { Screen, Card, Row, Button } from "@/components/ui";
import { PORTAL_URL, PRODUCT_NAME } from "@/constants";
import { legalUrl } from "@/lib/legal";
import { colors } from "@/theme";

export default function Account() {
  const app = useApp();
  const s = currentSession();
  return (
    <Screen>
      <Card title="Signed in">
        <Row title={app.employee ? `${app.employee.first_name} ${app.employee.last_name}` : s?.user.email || ""} subtitle={app.employee ? s?.user.email : undefined} />
        <Row title="Role" right={<Text style={styles.v}>{app.roleName || "—"}</Text>} />
        <Row title="Company" right={<Text style={styles.v}>{app.brandName}</Text>} />
        <Row title="Hotels" right={<Text style={styles.v}>{app.hotels.length}</Text>} />
      </Card>
      <Card title={`${PRODUCT_NAME} on the web`}>
        <Text style={styles.muted}>Reports, finance, compliance, capital and setup live in {PRODUCT_NAME} on the web.</Text>
        <Button kind="secondary" title={`Open ${PRODUCT_NAME} on the web`} onPress={() => Linking.openURL(PORTAL_URL)} />
      </Card>
      <Card title="Legal">
        <Row title="Terms of Service" onPress={() => Linking.openURL(legalUrl("terms"))} />
        <Row title="Privacy Policy" onPress={() => Linking.openURL(legalUrl("privacy-policy"))} />
        <Row title="Disclaimers" onPress={() => Linking.openURL(legalUrl("disclaimers"))} />
        <Row title="Accessibility" onPress={() => Linking.openURL(legalUrl("accessibility"))} />
      </Card>
      <Button kind="danger" title="Sign out" onPress={() => Alert.alert("Sign out?", undefined, [{ text: "Cancel", style: "cancel" }, { text: "Sign out", style: "destructive", onPress: () => auth.signOut() }])} />
      <Text style={styles.ver}>Version {Constants.expoConfig?.version || "1.0.0"}</Text>
    </Screen>
  );
}
const styles = StyleSheet.create({
  v: { fontSize: 15, color: colors.secondaryLabel },
  muted: { fontSize: 15, color: colors.secondaryLabel, lineHeight: 21 },
  ver: { textAlign: "center", fontSize: 12, color: colors.secondaryLabel },
});
