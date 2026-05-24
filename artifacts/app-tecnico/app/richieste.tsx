import { Feather } from "@expo/vector-icons";
import { LinearGradient } from "expo-linear-gradient";
import { Redirect, useFocusEffect, useRouter } from "expo-router";
import React, { useCallback, useEffect, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Linking,
  Platform,
  Pressable,
  RefreshControl,
  StyleSheet,
  Switch,
  Text,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { useAuth } from "@/contexts/AuthContext";
import { useColors } from "@/hooks/useColors";
import { fetchRichieste, formatEur, getDisponibilita, setDisponibilita, stripeOnboarding, type Richiesta } from "@/lib/api";

const STATO_COLORS: Record<string, { bg: string; col: string }> = {
  richiesta_creata:        { bg: "#fef3c7", col: "#92400e" },
  carta_autorizzata:       { bg: "#fef9c3", col: "#713f12" },
  tecnico_assegnato:       { bg: "#dbeafe", col: "#1e40af" },
  intervento_in_corso:     { bg: "#d1fae5", col: "#065f46" },
  completato_da_incassare: { bg: "#e0e7ff", col: "#3730a3" },
  incassato:               { bg: "#dcfce7", col: "#166534" },
  autorizzazione_annullata:{ bg: "#fee2e2", col: "#991b1b" },
  // legacy
  pagamento_autorizzato: { bg: "#fef9c3", col: "#713f12" },
  completato:            { bg: "#e0e7ff", col: "#3730a3" },
  annullato:             { bg: "#fee2e2", col: "#991b1b" },
  in_attesa:  { bg: "#fef3c7", col: "#92400e" },
  assegnata:  { bg: "#dbeafe", col: "#1e40af" },
  accettata:  { bg: "#d1fae5", col: "#065f46" },
  completata: { bg: "#e0e7ff", col: "#3730a3" },
  pagata:     { bg: "#dcfce7", col: "#166534" },
  annullata:  { bg: "#fee2e2", col: "#991b1b" },
};

export default function RichiesteScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { tecnico, token, signOut } = useAuth();
  const [data, setData] = useState<Richiesta[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [refreshing, setRefreshing] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [stripeLoading, setStripeLoading] = useState<boolean>(false);
  const [disponibile, setDisponibileState] = useState<boolean>(true);
  const [dispLoading, setDispLoading] = useState<boolean>(false);

  const toggleDisponibilita = async (nuovoValore: boolean) => {
    if (!token || dispLoading) return;
    setDispLoading(true);
    const precedente = disponibile;
    setDisponibileState(nuovoValore);
    try {
      const confermato = await setDisponibilita(token, nuovoValore);
      setDisponibileState(confermato);
    } catch (e) {
      setDisponibileState(precedente);
      Alert.alert("Errore", e instanceof Error ? e.message : "Impossibile aggiornare la disponibilità");
    } finally {
      setDispLoading(false);
    }
  };

  const avviaStripeOnboarding = async () => {
    if (!token) return;
    setStripeLoading(true);
    try {
      const r = await stripeOnboarding(token);
      await Linking.openURL(r.url);
    } catch (e) {
      Alert.alert("Errore", e instanceof Error ? e.message : "Impossibile aprire onboarding Stripe");
    } finally {
      setStripeLoading(false);
    }
  };

  const load = useCallback(async () => {
    if (!token) return;
    setError(null);
    try {
      const r = await fetchRichieste(token);
      setData(r);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Errore di rete");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [token]);

  useEffect(() => { void load(); }, [load]);
  useFocusEffect(useCallback(() => { void load(); }, [load]));

  useEffect(() => {
    if (!token) return;
    getDisponibilita(token).then(setDisponibileState).catch(() => {});
  }, [token]);

  if (!tecnico || !token) return <Redirect href="/" />;

  const onRefresh = () => { setRefreshing(true); void load(); };

  const attive = data.filter(r => ["tecnico_assegnato","assegnata","intervento_in_corso","accettata"].includes(r.stato));
  const concluse = data.filter(r => ["completato_da_incassare","completato","completata","incassato","pagata","autorizzazione_annullata","annullato","annullata"].includes(r.stato));

  const webTopInset = Platform.OS === "web" ? 67 : 0;

  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      <LinearGradient
        colors={[colors.headerStart, colors.headerEnd]}
        start={{ x: 0, y: 0 }}
        end={{ x: 1, y: 1 }}
        style={[styles.header, { paddingTop: insets.top + webTopInset + 18 }]}
      >
        <View style={{ flex: 1 }}>
          <Text style={styles.hello}>Ciao,</Text>
          <Text style={styles.name}>{tecnico.nome}</Text>
        </View>
        <Pressable onPress={signOut} style={({ pressed }) => [styles.iconBtn, { opacity: pressed ? 0.6 : 1 }]}>
          <Feather name="log-out" size={20} color="#fff" />
        </Pressable>
      </LinearGradient>

      <View style={[
        styles.dispBanner,
        {
          backgroundColor: disponibile ? "#dcfce7" : "#fee2e2",
          borderColor: disponibile ? "#16a34a" : "#dc2626",
          borderRadius: colors.radius,
        },
      ]}>
        <View style={{ flex: 1 }}>
          <Text style={[styles.dispTitle, { color: disponibile ? "#166534" : "#991b1b" }]}>
            {disponibile ? "🟢 DISPONIBILE" : "🔴 NON DISPONIBILE"}
          </Text>
          <Text style={[styles.dispSub, { color: disponibile ? "#166534" : "#991b1b" }]}>
            {disponibile ? "I clienti possono prenotare" : "Le prenotazioni sono bloccate"}
          </Text>
        </View>
        {dispLoading ? (
          <ActivityIndicator color={disponibile ? "#16a34a" : "#dc2626"} />
        ) : (
          <Switch
            value={disponibile}
            onValueChange={toggleDisponibilita}
            trackColor={{ false: "#fca5a5", true: "#86efac" }}
            thumbColor={disponibile ? "#16a34a" : "#dc2626"}
            ios_backgroundColor="#fca5a5"
          />
        )}
      </View>

      <View style={[styles.statsRow]}>
        <View style={[styles.statCard, { backgroundColor: colors.card, borderRadius: colors.radius, borderColor: colors.border }]}>
          <Text style={[styles.statNum, { color: colors.primary }]}>{attive.length}</Text>
          <Text style={[styles.statLbl, { color: colors.mutedForeground }]}>Attive</Text>
        </View>
        <View style={[styles.statCard, { backgroundColor: colors.card, borderRadius: colors.radius, borderColor: colors.border }]}>
          <Text style={[styles.statNum, { color: colors.foreground }]}>{concluse.length}</Text>
          <Text style={[styles.statLbl, { color: colors.mutedForeground }]}>Concluse</Text>
        </View>
        <View style={[styles.statCard, { backgroundColor: colors.card, borderRadius: colors.radius, borderColor: colors.border }]}>
          <Text style={[styles.statNum, { color: colors.accent }]}>★ {tecnico.rating}</Text>
          <Text style={[styles.statLbl, { color: colors.mutedForeground }]}>Rating</Text>
        </View>
      </View>

      {!tecnico.stripeOnboardingCompleto && (
        <Pressable
          onPress={avviaStripeOnboarding}
          disabled={stripeLoading}
          style={({ pressed }) => [
            styles.stripeBanner,
            { opacity: pressed || stripeLoading ? 0.7 : 1 },
          ]}
        >
          <Feather name="credit-card" size={16} color="#1a56db" />
          <Text style={styles.stripeBannerTxt}>
            {stripeLoading ? "Apertura..." : "⚠️ Configura pagamenti Stripe per ricevere i pagamenti →"}
          </Text>
        </Pressable>
      )}

      {loading ? (
        <View style={styles.center}><ActivityIndicator color={colors.primary} /></View>
      ) : error ? (
        <View style={styles.center}>
          <Feather name="wifi-off" size={32} color={colors.mutedForeground} />
          <Text style={[styles.errorTxt, { color: colors.foreground }]}>{error}</Text>
          <Pressable onPress={load} style={[styles.retryBtn, { backgroundColor: colors.primary, borderRadius: colors.radius - 4 }]}>
            <Text style={styles.retryTxt}>Riprova</Text>
          </Pressable>
        </View>
      ) : (
        <FlatList
          data={data}
          keyExtractor={(i) => String(i.id)}
          contentContainerStyle={{ padding: 16, paddingBottom: insets.bottom + 80 }}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.primary} />}
          ListEmptyComponent={
            <View style={styles.empty}>
              <Feather name="inbox" size={40} color={colors.mutedForeground} />
              <Text style={[styles.emptyTitle, { color: colors.foreground }]}>Nessuna richiesta</Text>
              <Text style={[styles.emptyTxt, { color: colors.mutedForeground }]}>
                Quando l'amministratore ti assegnerà un intervento, lo vedrai qui.
              </Text>
            </View>
          }
          renderItem={({ item }) => {
            const stat = STATO_COLORS[item.stato] ?? { bg: colors.muted, col: colors.foreground };
            return (
              <Pressable
                onPress={() => router.push(`/richiesta/${item.id}`)}
                style={({ pressed }) => [
                  styles.item,
                  { backgroundColor: colors.card, borderRadius: colors.radius, borderColor: colors.border, opacity: pressed ? 0.7 : 1 },
                ]}
              >
                <View style={styles.itemTop}>
                  <View style={{ flex: 1 }}>
                    <Text style={[styles.itemTitle, { color: colors.foreground }]} numberOfLines={1}>{item.servizioLabel}</Text>
                    <Text style={[styles.itemSub, { color: colors.mutedForeground }]} numberOfLines={1}>
                      <Feather name="map-pin" size={11} color={colors.mutedForeground} /> {item.indirizzo}
                    </Text>
                  </View>
                  <View style={[styles.badge, { backgroundColor: stat.bg }]}>
                    <Text style={[styles.badgeTxt, { color: stat.col }]}>{item.statoLabel}</Text>
                  </View>
                </View>
                <View style={styles.itemBottom}>
                  <Text style={[styles.itemMeta, { color: colors.mutedForeground }]}>
                    <Feather name="clock" size={11} /> {item.fasciaLabel}
                  </Text>
                  <Text style={[styles.itemPrice, { color: colors.primary }]}>{formatEur(item.prezzoUscitaCents)}</Text>
                </View>
              </Pressable>
            );
          }}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  header: {
    paddingHorizontal: 20,
    paddingBottom: 24,
    flexDirection: "row",
    alignItems: "center",
  },
  hello: { fontFamily: "Inter_400Regular", fontSize: 13, color: "rgba(255,255,255,0.85)" },
  name: { fontFamily: "Inter_700Bold", fontSize: 22, color: "#fff", letterSpacing: -0.4 },
  iconBtn: {
    width: 40, height: 40, borderRadius: 12,
    backgroundColor: "rgba(255,255,255,0.15)",
    alignItems: "center", justifyContent: "center",
  },
  statsRow: {
    flexDirection: "row",
    paddingHorizontal: 16,
    marginTop: -16,
    marginBottom: 8,
    gap: 10,
  },
  statCard: {
    flex: 1,
    paddingVertical: 14,
    alignItems: "center",
    borderWidth: 1,
    shadowColor: "#000",
    shadowOpacity: 0.06,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 2 },
    elevation: 2,
  },
  statNum: { fontFamily: "Inter_700Bold", fontSize: 22 },
  statLbl: { fontFamily: "Inter_500Medium", fontSize: 11, marginTop: 2, letterSpacing: 0.4, textTransform: "uppercase" },
  center: { flex: 1, alignItems: "center", justifyContent: "center", padding: 32, gap: 12 },
  errorTxt: { fontFamily: "Inter_500Medium", fontSize: 14, textAlign: "center" },
  retryBtn: { paddingHorizontal: 20, paddingVertical: 10, marginTop: 8 },
  retryTxt: { fontFamily: "Inter_700Bold", color: "#fff", fontSize: 14 },
  dispBanner: {
    flexDirection: "row",
    alignItems: "center",
    marginHorizontal: 16,
    marginTop: 12,
    paddingVertical: 12,
    paddingHorizontal: 14,
    borderWidth: 1.5,
    gap: 12,
  },
  dispTitle: {
    fontSize: 15,
    fontWeight: "800",
    letterSpacing: 0.3,
  },
  dispSub: {
    fontSize: 12,
    fontWeight: "600",
    marginTop: 2,
    opacity: 0.85,
  },
  stripeBanner: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    marginHorizontal: 16,
    marginBottom: 8,
    marginTop: 4,
    backgroundColor: "#eff6ff",
    borderWidth: 1,
    borderColor: "#bfdbfe",
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  stripeBannerTxt: {
    fontFamily: "Inter_600SemiBold",
    fontSize: 13,
    color: "#1a56db",
  },
  empty: { alignItems: "center", padding: 48, gap: 10 },
  emptyTitle: { fontFamily: "Inter_700Bold", fontSize: 17, marginTop: 4 },
  emptyTxt: { fontFamily: "Inter_400Regular", fontSize: 13, textAlign: "center", lineHeight: 18, maxWidth: 280 },
  item: {
    padding: 16,
    marginBottom: 10,
    borderWidth: 1,
  },
  itemTop: { flexDirection: "row", alignItems: "flex-start", gap: 10 },
  itemTitle: { fontFamily: "Inter_700Bold", fontSize: 15, marginBottom: 4 },
  itemSub: { fontFamily: "Inter_400Regular", fontSize: 12 },
  badge: { paddingHorizontal: 9, paddingVertical: 4, borderRadius: 999 },
  badgeTxt: { fontFamily: "Inter_600SemiBold", fontSize: 10, textTransform: "uppercase", letterSpacing: 0.4 },
  itemBottom: {
    flexDirection: "row", justifyContent: "space-between", alignItems: "center",
    marginTop: 12, paddingTop: 10, borderTopWidth: 1, borderTopColor: "#f0f4f8",
  },
  itemMeta: { fontFamily: "Inter_500Medium", fontSize: 12 },
  itemPrice: { fontFamily: "Inter_700Bold", fontSize: 16 },
});
