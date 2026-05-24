import AsyncStorage from "@react-native-async-storage/async-storage";
import React, { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { Platform } from "react-native";
import * as Notifications from "expo-notifications";
import * as Device from "expo-device";
import { type Tecnico, login as apiLogin, registerExpoToken } from "@/lib/api";

const STORAGE_KEY = "@prontointervento/tecnico-auth";

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowAlert: true,
    shouldPlaySound: true,
    shouldSetBadge: true,
    shouldShowBanner: true,
    shouldShowList: true,
  }),
});

async function getPushToken(): Promise<string | null> {
  if (!Device.isDevice) return null;
  if (Platform.OS === "android") {
    await Notifications.setNotificationChannelAsync("default", {
      name: "default",
      importance: Notifications.AndroidImportance.MAX,
      vibrationPattern: [0, 250, 250, 250],
    });
  }
  const { status: existing } = await Notifications.getPermissionsAsync();
  let finalStatus = existing;
  if (existing !== "granted") {
    const { status } = await Notifications.requestPermissionsAsync();
    finalStatus = status;
  }
  if (finalStatus !== "granted") return null;
  const tokenData = await Notifications.getExpoPushTokenAsync();
  return tokenData.data;
}

type AuthState = {
  tecnico: Tecnico | null;
  token: string | null;
  loading: boolean;
  signIn: (telefono: string, pin: string) => Promise<void>;
  signOut: () => Promise<void>;
};

const AuthCtx = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [tecnico, setTecnico] = useState<Tecnico | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [loading, setLoading] = useState<boolean>(true);

  const registerPush = async (authToken: string) => {
    try {
      const pushToken = await getPushToken();
      if (pushToken) {
        await registerExpoToken(pushToken, authToken);
      }
    } catch {
      // silently ignore push registration errors
    }
  };

  useEffect(() => {
    (async () => {
      try {
        const raw = await AsyncStorage.getItem(STORAGE_KEY);
        if (raw) {
          const data = JSON.parse(raw) as { tecnico: Tecnico; token: string };
          setTecnico(data.tecnico);
          setToken(data.token);
          void registerPush(data.token);
        }
      } catch {
        // ignore
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const signIn = async (telefono: string, pin: string) => {
    const { tecnico: t, token: tk } = await apiLogin(telefono, pin);
    await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify({ tecnico: t, token: tk }));
    setTecnico(t);
    setToken(tk);
    void registerPush(tk);
  };

  const signOut = async () => {
    await AsyncStorage.removeItem(STORAGE_KEY);
    setTecnico(null);
    setToken(null);
  };

  return <AuthCtx.Provider value={{ tecnico, token, loading, signIn, signOut }}>{children}</AuthCtx.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthCtx);
  if (!ctx) throw new Error("useAuth must be used inside AuthProvider");
  return ctx;
}
