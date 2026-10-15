import React from "react";
import { StyleSheet, Text, View } from "react-native";
import { auth, currentSession } from "@/lib/sb";
import { Button } from "@/components/ui";
import { space } from "@/theme";

export default function NoAccess() {
  return (
    <View style={styles.wrap}>
      <Text style={styles.title}>Almost there</Text>
      <Text style={styles.sub}>You're signed in as {currentSession()?.user.email}, but this account isn't linked to a company yet. Ask your manager to invite this email address, then sign in again.</Text>
      <Button title="Sign out" kind="secondary" onPress={() => auth.signOut()} />
    </View>
  );
}
const styles = StyleSheet.create({
  wrap: { flex: 1, justifyContent: "center", padding: space.xl, gap: space.lg, backgroundColor: "#FBF7EE" },
  title: { fontSize: 28, fontWeight: "700", color: "#1E2430" },
  sub: { fontSize: 15, color: "#4A5262", lineHeight: 21 },
});
