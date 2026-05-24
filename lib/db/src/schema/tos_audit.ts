import { pgTable, serial, text, timestamp, integer } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const tosAuditTable = pgTable("tos_audit", {
  id: serial("id").primaryKey(),
  contesto: text("contesto").notNull(),
  fascia: text("fascia"),
  ipAddress: text("ip_address"),
  userAgent: text("user_agent"),
  versione: text("versione").notNull(),
  riferimentoRichiestaId: integer("riferimento_richiesta_id"),
  stripeSessionId: text("stripe_session_id"),
  accettatoAt: timestamp("accettato_at").defaultNow().notNull(),
});

export const insertTosAuditSchema = createInsertSchema(tosAuditTable).omit({ id: true, accettatoAt: true });
export type InsertTosAudit = z.infer<typeof insertTosAuditSchema>;
export type TosAudit = typeof tosAuditTable.$inferSelect;
