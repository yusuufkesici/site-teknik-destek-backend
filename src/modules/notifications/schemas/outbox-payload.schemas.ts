import { z } from 'zod';

// Faz 8 (onaylanan docs/phase-8-plan.md Bolum 4): islenen 4 eventType icin
// sema. Yalniz gerekli id/guvenli alanlar tasinir - tutar veya kisisel veri
// outbox payload'ina yazilmaz.

export const emergencyTicketCreatedPayloadSchema = z.object({
  ticketId: z.string().uuid(),
  ticketCode: z.string(),
  siteId: z.string().uuid(),
  facilityId: z.string().uuid(),
  category: z.string(),
  urgency: z.literal('EMERGENCY'),
  createdByUserId: z.string().uuid(),
});

export type EmergencyTicketCreatedPayload = z.infer<typeof emergencyTicketCreatedPayloadSchema>;

export const technicianAssignedPayloadSchema = z.object({
  ticketId: z.string().uuid(),
  assignmentId: z.string().uuid(),
  technicianId: z.string().uuid(),
  reassigned: z.boolean(),
});

export type TechnicianAssignedPayload = z.infer<typeof technicianAssignedPayloadSchema>;

export const contractExpiringPayloadSchema = z.object({
  contractId: z.string().uuid(),
  contractNumber: z.string(),
  siteId: z.string().uuid(),
  endDate: z.string(),
});

export type ContractExpiringPayload = z.infer<typeof contractExpiringPayloadSchema>;

export const invoiceOverduePayloadSchema = z.object({
  invoiceId: z.string().uuid(),
  contractId: z.string().uuid(),
  siteId: z.string().uuid(),
  invoiceNumber: z.string(),
  dueDate: z.string(),
});

export type InvoiceOverduePayload = z.infer<typeof invoiceOverduePayloadSchema>;
