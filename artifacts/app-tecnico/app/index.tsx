import { Feather } from "@expo/vector-icons";
import { LinearGradient } from "expo-linear-gradient";
import { Redirect } from "expo-router";
import * as Haptics from "expo-haptics";
import React, { useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Image,
  KeyboardAvoidingView,
  Linking,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { useAuth } from "@/contexts/AuthContext";
import { useColors } from "@/hooks/useColors";

const PIM_LOGO = require("../assets/pim-logo.png");

export default function LoginScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const { tecnico, loading: authLoading, signIn } = useAuth();
  const [telefono, setTelefono] = useState<string>("");
  const [pin, setPin] = useState<string>("");
  const [submitting, setSubmitting] = useState<boolean>(false);

  if (authLoading) {
    return (
      <View style={[styles.center, { backgroundColor: colors.background }]}>
        <ActivityIndicator color={colors.primary} />
      </View>
    );
  }

  if (tecnico) return <Redirect href="/richieste" />;

  const handleLogin = async () => {
    if (!telefono.trim() || !pin.trim()) {
      Alert.alert("Dati mancanti", "Inserisci telefono e PIN.");
      return;
    }
    setSubmitting(true);
    try {
      await signIn(telefono.trim(), pin.trim());
      if (Platform.OS !== "web") {
        await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      }
    } catch (e) {
      if (Platform.OS !== "web") {
        await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      }
      Alert.alert("Accesso non riuscito", e instanceof Error ? e.message : "Riprova");
    } finally {
      setSubmitting(false);
    }
  };

  const webTopInset = Platform.OS === "web" ? 67 : 0;

  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      <LinearGradient
        colors={["#0f2244", "#1e3a5f"]}
        start={{ x: 0, y: 0 }}
        end={{ x: 1, y: 1 }}
        style={[styles.hero, { paddingTop: insets.top + webTopInset + 32 }]}
      >
        <Image source={PIM_LOGO} style={styles.logoImg} resizeMode="contain" />
        <Text style={styles.brand}>prontointerventomi.it</Text>
        <Text style={styles.byline}>by ELETTROTECH</Text>
        <View style={styles.appTagWrap}>
          <Text style={styles.tag}>APP TECNICO</Text>
        </View>
      </LinearGradient>

      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : undefined}
        style={styles.formWrap}
      >
        <View style={[styles.card, { backgroundColor: colors.card, borderRadius: colors.radius, borderColor: colors.border }]}>
          <Text style={[styles.title, { color: colors.foreground }]}>Accedi</Text>
          <Text style={[styles.subtitle, { color: colors.mutedForeground }]}>
            Inserisci il telefono e il PIN ricevuto dall'amministratore
          </Text>

          <Text style={[styles.label, { color: colors.mutedForeground }]}>TELEFONO</Text>
          <TextInput
            value={telefono}
            onChangeText={setTelefono}
            placeholder="+39 333 1234567"
            placeholderTextColor={colors.mutedForeground}
            keyboardType="phone-pad"
            autoCapitalize="none"
            style={[styles.input, { backgroundColor: colors.muted, borderColor: colors.border, color: colors.foreground, borderRadius: colors.radius - 4 }]}
            testID="input-telefono"
          />

          <Text style={[styles.label, { color: colors.mutedForeground, marginTop: 16 }]}>PIN</Text>
          <TextInput
            value={pin}
            onChangeText={setPin}
            placeholder="4 cifre"
            placeholderTextColor={colors.mutedForeground}
            keyboardType="number-pad"
            secureTextEntry
            maxLength={6}
            style={[styles.input, { backgroundColor: colors.muted, borderColor: colors.border, color: colors.foreground, borderRadius: colors.radius - 4 }]}
            testID="input-pin"
          />

          <Pressable
            onPress={handleLogin}
            disabled={submitting}
            style={({ pressed }) => [
              styles.btn,
              { backgroundColor: colors.primary, borderRadius: colors.radius - 4, opacity: submitting ? 0.5 : pressed ? 0.85 : 1 },
            ]}
            testID="btn-login"
          >
            {submitting ? (
              <ActivityIndicator color="#fff" />
            ) : (
              <Text style={styles.btnText}>Entra</Text>
            )}
          </Pressable>
        </View>

        <Pressable
          onPress={() => void Linking.openURL("tel:+393405707813")}
          style={({ pressed }) => [styles.callBtn, { opacity: pressed ? 0.75 : 1 }]}
        >
          <Feather name="phone" size={16} color="#c0392b" />
          <Text style={styles.callBtnTxt}>Contatta l'amministratore: 340 570 7813</Text>
        </Pressable>
      </KeyboardAvoidingView>
    </View>
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: "center", justifyContent: "center" },

  hero: {
    paddingBottom: 44,
    paddingHorizontal: 24,
    alignItems: "center",
  },

  logoImg: {
    width: 130,
    height: 130,
    marginBottom: 14,
  },

  brand: {
    fontFamily: "Inter_700Bold",
    fontSize: 22,
    color: "#fff",
    letterSpacing: -0.5,
  },
  byline: {
    fontFamily: "Inter_500Medium",
    fontSize: 11,
    color: "rgba(255,255,255,0.6)",
    marginTop: 2,
    letterSpacing: 0.5,
  },
  appTagWrap: {
    marginTop: 12,
    backgroundColor: "rgba(255,255,255,0.12)",
    borderRadius: 20,
    paddingHorizontal: 12,
    paddingVertical: 4,
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.2)",
  },
  tag: {
    fontFamily: "Inter_600SemiBold",
    fontSize: 11,
    color: "#fbbf24",
    letterSpacing: 3,
  },

  formWrap: {
    flex: 1,
    paddingHorizontal: 20,
    marginTop: -24,
  },
  card: {
    padding: 22,
    borderWidth: 1,
    shadowColor: "#000",
    shadowOpacity: 0.08,
    shadowRadius: 16,
    shadowOffset: { width: 0, height: 4 },
    elevation: 4,
  },
  title: { fontFamily: "Inter_700Bold", fontSize: 22, marginBottom: 4 },
  subtitle: { fontFamily: "Inter_400Regular", fontSize: 13, marginBottom: 20, lineHeight: 18 },
  label: { fontFamily: "Inter_600SemiBold", fontSize: 11, letterSpacing: 0.6, marginBottom: 6 },
  input: {
    fontFamily: "Inter_500Medium",
    fontSize: 16,
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderWidth: 1.5,
  },
  btn: {
    marginTop: 24,
    paddingVertical: 14,
    alignItems: "center",
    justifyContent: "center",
  },
  btnText: { fontFamily: "Inter_700Bold", fontSize: 16, color: "#fff" },
  callBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    marginTop: 20,
    paddingVertical: 12,
    paddingHorizontal: 18,
    borderWidth: 1.5,
    borderColor: "#fecaca",
    borderRadius: 12,
    backgroundColor: "#fff5f5",
  },
  callBtnTxt: {
    fontFamily: "Inter_600SemiBold",
    fontSize: 13,
    color: "#c0392b",
  },
});
