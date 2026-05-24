import { pgTable, text, timestamp } from "drizzle-orm/pg-core";

export const impostazioniTable = pgTable("impostazioni", {
  chiave: text("chiave").primaryKey(),
  valore: text("valore").notNull(),
  aggiornatoAt: timestamp("aggiornato_at").defaultNow().notNull(),
});

export type Impostazione = typeof impostazioniTable.$inferSelect;
