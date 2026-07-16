import { z } from 'zod';

// Faz 8 Dilim 1 (onaylanan docs/phase-8-plan.md Bolum 4): yalniz bu dilimde
// islenen 2 eventType icin sema. ContractExpiring/InvoiceOverdue semalari
// Dilim 2'de eklenecek - o eventType'lar henuz hic uretilmiyor.

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
