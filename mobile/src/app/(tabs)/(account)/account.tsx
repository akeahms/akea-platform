import React from "react";
import { Alert, Linking, StyleSheet, Text } from "react-native";
import Constants from "expo-constants";
import { auth, currentSession } from "@/lib/sb";
import { useApp } from "@/lib/app";
import { Screen, Card, Row, Button } from "@/components/ui";
import { PORTAL_URL } from "@/constants";
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
      <Card title="Full portal">
        <Text style={styles.muted}>Reports, finance, compliance, capital and setup live in the web portal.</Text>
        <Button kind="secondary" title="Open the web portal" onPress={() => Linking.openURL(PORTAL_URL)} />
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
