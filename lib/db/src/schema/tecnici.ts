import { pgTable, serial, text, timestamp, boolean, integer } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const tecniciTable = pgTable("tecnici", {
  id: serial("id").primaryKey(),
  nome: text("nome").notNull(),
  telefono: text("telefono").notNull(),
  email: text("email"),
  categorie: text("categorie").array().notNull(),
  capServiti: text("cap_serviti").array().notNull(),
  rating: integer("rating").default(50).notNull(),
  pin: text("pin"),
  attivo: boolean("attivo").default(true).notNull(),
  prontoIntervento: boolean("pronto_intervento").default(true).notNull(),
  stripeAccountId: text("stripe_account_id"),
  expoToken: text("expo_token"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const insertTecnicoSchema = createInsertSchema(tecniciTable).omit({ id: true, createdAt: true });
export type InsertTecnico = z.infer<typeof insertTecnicoSchema>;
export type Tecnico = typeof tecniciTable.$inferSelect;
