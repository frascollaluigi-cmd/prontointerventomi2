import { Expo, type ExpoPushMessage } from "expo-server-sdk";
import { logger } from "./lib/logger";

const expo = new Expo();

export async function sendPushNotification(
  expoToken: string | null | undefined,
  title: string,
  body: string,
  data?: Record<string, unknown>,
): Promise<void> {
  if (!expoToken) return;
  if (!Expo.isExpoPushToken(expoToken)) {
    logger.warn({ expoToken }, "Token Expo non valido, skip push");
    return;
  }
  const message: ExpoPushMessage = {
    to: expoToken,
    sound: "default",
    title,
    body,
    data: data ?? {},
    priority: "high",
  };
  try {
    const chunks = expo.chunkPushNotifications([message]);
    for (const chunk of chunks) {
      const receipts = await expo.sendPushNotificationsAsync(chunk);
      for (const receipt of receipts) {
        if (receipt.status === "error") {
          logger.error({ receipt }, "Errore invio push");
        }
      }
    }
  } catch (err) {
    logger.error({ err }, "Eccezione invio push");
  }
}
