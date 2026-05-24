import { Platform } from "react-native";

const DOMAIN = process.env.EXPO_PUBLIC_DOMAIN;
const BASE = Platform.OS === "web" ? "" : (DOMAIN ? `https://${DOMAIN}` : "");

export type Tecnico = {
  id: number;
  nome: string;
  telefono: string;
  email: string | null;
  categorie: string[];
  capServiti: string[];
  rating: number;
  stripeOnboardingCompleto: boolean;
};

export type Richiesta = {
  id: number;
  nome: string;
  telefono: string;
  indirizzo: string;
  cap: string | null;
  servizio: string;
  servizioLabel: string;
  fasciaOraria: string;
  fasciaLabel: string;
  prezzoUscitaCents: number;
  stato: string;
  statoLabel: string;
  createdAt: string;
};

export type Azione = "accetta" | "rifiuta" | "completa";

export async function login(telefono: string, pin: string): Promise<{ tecnico: Tecnico; token: string }> {
  const res = await fetch(`${BASE}/api/tecnico/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ telefono, pin }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.errore || "Errore login");
  const token = btoa(`${data.tecnico.id}:${pin}`);
  return { tecnico: data.tecnico, token };
}

export async function fetchRichieste(token: string): Promise<Richiesta[]> {
  const res = await fetch(`${BASE}/api/tecnico/richieste`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.errore || "Errore caricamento");
  return data.richieste;
}

export async function azioneRichiesta(token: string, id: number, azione: Azione): Promise<{ nuovoStato: string }> {
  const res = await fetch(`${BASE}/api/tecnico/richiesta/${id}/azione`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ azione }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.errore || "Errore");
  return data;
}

export async function stripeOnboarding(authToken: string): Promise<{ url: string }> {
  const res = await fetch(`${BASE}/api/tecnico/stripe/onboarding`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${authToken}` },
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.errore || "Errore onboarding");
  return data;
}

export async function registerExpoToken(token: string, authToken: string): Promise<void> {
  await fetch(`${BASE}/api/tecnico/expo-token`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${authToken}` },
    body: JSON.stringify({ token }),
  });
}

export async function getDisponibilita(token: string): Promise<boolean> {
  const res = await fetch(`${BASE}/api/tecnico/disponibilita`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.errore || "Errore lettura disponibilità");
  return Boolean(data.disponibile);
}

export async function setDisponibilita(token: string, disponibile: boolean): Promise<boolean> {
  const res = await fetch(`${BASE}/api/tecnico/disponibilita`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ disponibile }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.errore || "Errore aggiornamento disponibilità");
  return Boolean(data.disponibile);
}

export function formatEur(cents: number): string {
  return (cents / 100).toFixed(2).replace(".", ",") + " €";
}
