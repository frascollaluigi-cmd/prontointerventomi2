import { pgTable, serial, text, timestamp, integer } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const richiesteTable = pgTable("richieste", {
  id: serial("id").primaryKey(),
  nome: text("nome").notNull(),
  telefono: text("telefono").notNull(),
  indirizzo: text("indirizzo").notNull(),
  cap: text("cap"),
  servizio: text("servizio").notNull(),
  fasciaOraria: text("fascia_oraria").default("standard").notNull(),
  prezzoUscitaCents: integer("prezzo_uscita_cents").default(5900).notNull(),
  stato: text("stato").default("richiesta_creata").notNull(),
  tecnicoId: integer("tecnico_id"),
  accettazioneCondizioni: text("accettazione_condizioni"),
  stripePaymentIntentId: text("stripe_payment_intent_id"),
  richiedeFattura: text("richiede_fattura"),
  datiFatturazione: text("dati_fatturazione"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const insertRichiestaSchema = createInsertSchema(richiesteTable).omit({ id: true, createdAt: true });
export type InsertRichiesta = z.infer<typeof insertRichiestaSchema>;
export type Richiesta = typeof richiesteTable.$inferSelect;
