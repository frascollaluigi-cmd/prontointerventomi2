import { Feather } from "@expo/vector-icons";
import * as Haptics from "expo-haptics";
import { LinearGradient } from "expo-linear-gradient";
import { Redirect, useLocalSearchParams, useRouter } from "expo-router";
import React, { useEffect, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Linking,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { useAuth } from "@/contexts/AuthContext";
import { useColors } from "@/hooks/useColors";
import { azioneRichiesta, fetchRichieste, formatEur, type Azione, type Richiesta } from "@/lib/api";

export default function RichiestaDetail() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const { tecnico, token } = useAuth();
  const [richiesta, setRichiesta] = useState<Richiesta | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [busy, setBusy] = useState<boolean>(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  const load = React.useCallback(async () => {
    if (!token || !id) return;
    setLoading(true);
    setLoadError(null);
    try {
      const list = await fetchRichieste(token);
      const r = list.find((x) => String(x.id) === String(id));
      setRichiesta(r ?? null);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : "Errore di rete");
    } finally {
      setLoading(false);
    }
  }, [token, id]);

  useEffect(() => { void load(); }, [load]);

  if (!tecnico || !token) return <Redirect href="/" />;

  const webTopInset = Platform.OS === "web" ? 67 : 0;

  if (loading) {
    return (
      <View style={[styles.center, { backgroundColor: colors.background }]}>
        <ActivityIndicator color={colors.primary} />
      </View>
    );
  }

  if (loadError) {
    return (
      <View style={[styles.center, { backgroundColor: colors.background, padding: 24 }]}>
        <Feather name="wifi-off" size={36} color={colors.mutedForeground} />
        <Text style={[styles.errTxt, { color: colors.foreground }]}>{loadError}</Text>
        <Pressable onPress={load} style={[styles.btnSec, { borderColor: colors.border }]}>
          <Text style={[styles.btnSecTxt, { color: colors.foreground }]}>Riprova</Text>
        </Pressable>
      </View>
    );
  }

  if (!richiesta) {
    return (
      <View style={[styles.center, { backgroundColor: colors.background, padding: 24 }]}>
        <Feather name="alert-circle" size={36} color={colors.mutedForeground} />
        <Text style={[styles.errTxt, { color: colors.foreground }]}>Richiesta non trovata</Text>
        <Pressable onPress={() => router.back()} style={[styles.btnSec, { borderColor: colors.border }]}>
          <Text style={[styles.btnSecTxt, { color: colors.foreground }]}>Torna indietro</Text>
        </Pressable>
      </View>
    );
  }

  const callCustomer = () => {
    void Linking.openURL(`tel:${richiesta.telefono}`);
  };

  const openMaps = () => {
    const q = encodeURIComponent(`${richiesta.indirizzo}${richiesta.cap ? " " + richiesta.cap : ""}`);
    const url = Platform.select({
      ios: `http://maps.apple.com/?q=${q}`,
      android: `geo:0,0?q=${q}`,
      default: `https://www.google.com/maps/search/?api=1&query=${q}`,
    });
    void Linking.openURL(url!);
  };

  const doAction = async (azione: Azione, confirmTxt?: string) => {
    if (confirmTxt) {
      const ok = await new Promise<boolean>((resolve) => {
        Alert.alert("Conferma", confirmTxt, [
          { text: "Annulla", onPress: () => resolve(false), style: "cancel" },
          { text: "Conferma", onPress: () => resolve(true) },
        ]);
      });
      if (!ok) return;
    }
    setBusy(true);
    try {
      const r = await azioneRichiesta(token, richiesta.id, azione);
      if (Platform.OS !== "web") {
        await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      }
      setRichiesta({ ...richiesta, stato: r.nuovoStato, statoLabel: r.nuovoStato });
      router.back();
    } catch (e) {
      Alert.alert("Errore", e instanceof Error ? e.message : "Operazione fallita");
    } finally {
      setBusy(false);
    }
  };

  const stato = richiesta.stato;
  const canAccept = stato === "tecnico_assegnato" || stato === "assegnata";
  const canReject = stato === "tecnico_assegnato" || stato === "assegnata";
  const canComplete = stato === "intervento_in_corso" || stato === "accettata" || stato === "tecnico_assegnato" || stato === "assegnata";

  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      <LinearGradient
        colors={[colors.headerStart, colors.headerEnd]}
        start={{ x: 0, y: 0 }}
        end={{ x: 1, y: 1 }}
        style={[styles.header, { paddingTop: insets.top + webTopInset + 14 }]}
      >
        <Pressable onPress={() => router.back()} style={({ pressed }) => [styles.iconBtn, { opacity: pressed ? 0.6 : 1 }]}>
          <Feather name="chevron-left" size={22} color="#fff" />
        </Pressable>
        <Text style={styles.title}>Intervento #{richiesta.id}</Text>
        <View style={{ width: 40 }} />
      </LinearGradient>

      <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: insets.bottom + 140 }}>
        <View style={[styles.card, { backgroundColor: colors.card, borderRadius: colors.radius, borderColor: colors.border }]}>
          <View style={styles.cardHeader}>
            <Text style={[styles.servizio, { color: colors.primary }]}>{richiesta.servizioLabel}</Text>
            <Text style={[styles.fascia, { color: colors.mutedForeground }]}>{richiesta.fasciaLabel}</Text>
          </View>
          <View style={[styles.priceBox]}>
            <Text style={[styles.priceLbl]}>Costo di uscita</Text>
            <Text style={[styles.priceVal]}>{formatEur(richiesta.prezzoUscitaCents)}</Text>
          </View>
        </View>

        <Text style={[styles.sectionTitle, { color: colors.mutedForeground }]}>CLIENTE</Text>
        <View style={[styles.card, { backgroundColor: colors.card, borderRadius: colors.radius, borderColor: colors.border }]}>
          <Text style={[styles.cliNome, { color: colors.foreground }]}>{richiesta.nome}</Text>
          <Pressable onPress={callCustomer} style={({ pressed }) => [styles.row, { opacity: pressed ? 0.6 : 1 }]}>
            <Feather name="phone" size={16} color={colors.primary} />
            <Text style={[styles.rowTxt, { color: colors.primary, fontFamily: "Inter_600SemiBold" }]}>{richiesta.telefono}</Text>
          </Pressable>
          <Pressable onPress={openMaps} style={({ pressed }) => [styles.row, { opacity: pressed ? 0.6 : 1 }]}>
            <Feather name="map-pin" size={16} color={colors.primary} />
            <Text style={[styles.rowTxt, { color: colors.foreground }]}>
              {richiesta.indirizzo}{richiesta.cap ? `\n${richiesta.cap} Milano` : ""}
            </Text>
          </Pressable>
        </View>

        <Text style={[styles.sectionTitle, { color: colors.mutedForeground }]}>STATO</Text>
        <View style={[styles.card, { backgroundColor: colors.card, borderRadius: colors.radius, borderColor: colors.border, flexDirection: "row", alignItems: "center" }]}>
          <View style={[styles.dot, { backgroundColor: ["completato","completata","incassato","pagata"].includes(stato) ? colors.success : ["intervento_in_corso","accettata"].includes(stato) ? colors.success : colors.warning }]} />
          <Text style={[styles.statoTxt, { color: colors.foreground }]}>{richiesta.statoLabel}</Text>
        </View>
      </ScrollView>

      {(canAccept || canReject || canComplete) && (
        <View style={[styles.actions, { paddingBottom: insets.bottom + 12, backgroundColor: colors.card, borderTopColor: colors.border }]}>
          {canAccept && (
            <Pressable
              onPress={() => doAction("accetta")}
              disabled={busy}
              style={({ pressed }) => [styles.actBtn, { backgroundColor: colors.success, borderRadius: colors.radius - 4, opacity: busy ? 0.5 : pressed ? 0.85 : 1 }]}
            >
              <Feather name="check" size={18} color="#fff" />
              <Text style={styles.actTxt}>Accetta</Text>
            </Pressable>
          )}
          {canReject && (
            <Pressable
              onPress={() => doAction("rifiuta", "Vuoi rifiutare questo intervento? Tornerà in coda.")}
              disabled={busy}
              style={({ pressed }) => [styles.actBtn, { backgroundColor: colors.muted, borderRadius: colors.radius - 4, opacity: busy ? 0.5 : pressed ? 0.85 : 1 }]}
            >
              <Feather name="x" size={18} color={colors.foreground} />
              <Text style={[styles.actTxt, { color: colors.foreground }]}>Rifiuta</Text>
            </Pressable>
          )}
          {canComplete && !canAccept && (
            <Pressable
              onPress={() => doAction("completa", "Confermi che l'intervento è stato completato?")}
              disabled={busy}
              style={({ pressed }) => [styles.actBtn, { backgroundColor: colors.primary, borderRadius: colors.radius - 4, opacity: busy ? 0.5 : pressed ? 0.85 : 1 }]}
            >
              <Feather name="check-circle" size={18} color="#fff" />
              <Text style={styles.actTxt}>Completata</Text>
            </Pressable>
          )}
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: "center", justifyContent: "center", gap: 12 },
  errTxt: { fontFamily: "Inter_600SemiBold", fontSize: 16 },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 14,
    paddingBottom: 18,
  },
  iconBtn: {
    width: 40, height: 40, borderRadius: 12,
    backgroundColor: "rgba(255,255,255,0.15)",
    alignItems: "center", justifyContent: "center",
  },
  title: { fontFamily: "Inter_700Bold", fontSize: 17, color: "#fff" },
  card: {
    padding: 16,
    borderWidth: 1,
    marginBottom: 8,
  },
  cardHeader: { marginBottom: 14 },
  servizio: { fontFamily: "Inter_700Bold", fontSize: 18 },
  fascia: { fontFamily: "Inter_500Medium", fontSize: 13, marginTop: 2 },
  priceBox: {
    backgroundColor: "#1a202c",
    padding: 14,
    borderRadius: 10,
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  priceLbl: { fontFamily: "Inter_500Medium", fontSize: 12, color: "rgba(255,255,255,0.75)", textTransform: "uppercase", letterSpacing: 0.5 },
  priceVal: { fontFamily: "Inter_700Bold", fontSize: 22, color: "#fff" },
  sectionTitle: {
    fontFamily: "Inter_600SemiBold",
    fontSize: 11,
    letterSpacing: 1,
    marginTop: 16,
    marginBottom: 6,
    paddingHorizontal: 4,
  },
  cliNome: { fontFamily: "Inter_700Bold", fontSize: 17, marginBottom: 12 },
  row: { flexDirection: "row", alignItems: "center", gap: 10, paddingVertical: 10 },
  rowTxt: { fontFamily: "Inter_500Medium", fontSize: 14, flex: 1 },
  dot: { width: 10, height: 10, borderRadius: 5, marginRight: 10 },
  statoTxt: { fontFamily: "Inter_600SemiBold", fontSize: 15 },
  actions: {
    position: "absolute",
    left: 0, right: 0, bottom: 0,
    flexDirection: "row",
    gap: 10,
    padding: 14,
    borderTopWidth: 1,
  },
  actBtn: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    paddingVertical: 14,
  },
  actTxt: { fontFamily: "Inter_700Bold", color: "#fff", fontSize: 15 },
  btnSec: { paddingHorizontal: 18, paddingVertical: 10, borderWidth: 1, borderRadius: 10 },
  btnSecTxt: { fontFamily: "Inter_600SemiBold", fontSize: 14 },
});
