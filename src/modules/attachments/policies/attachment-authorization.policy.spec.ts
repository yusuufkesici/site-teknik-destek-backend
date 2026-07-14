import type { AuthenticatedUser } from '../../../common/types/authenticated-user.type';
import type { TicketRow } from '../../tickets/repositories/ticket.repository';
import type { AssignmentAttachmentCheckRow } from '../../assignments/services/assignment-lookup.service';
import { AttachmentAuthorizationPolicy } from './attachment-authorization.policy';

function actor(role: AuthenticatedUser['role'], id = 'actor-1'): AuthenticatedUser {
  return { id, role, sessionId: 's', tokenVersion: 0 };
}

function buildTicket(overrides: Partial<TicketRow> = {}): TicketRow {
  return {
    id: 'ticket-1',
    code: 'TKT-2026-000001',
    createdByUserId: 'resident-1',
    siteId: 'site-1',
    facilityId: 'facility-1',
    title: 't',
    description: 'd',
    category: 'PLUMBING' as never,
    urgency: 'STANDARD' as never,
    status: 'IN_PROGRESS' as never,
    source: 'RESIDENT' as never,
    slaTargetAt: null,
    isRecurring: false,
    operationNote: null,
    completedAt: null,
    cancelledAt: null,
    cancellationReason: null,
    version: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
    deletedAt: null,
    ...overrides,
  };
}

function buildAssignment(
  overrides: Partial<AssignmentAttachmentCheckRow> = {},
): AssignmentAttachmentCheckRow {
  return {
    id: 'assignment-1',
    ticketId: 'ticket-1',
    technicianId: 'tech-1',
    status: 'ACTIVE' as never,
    isCurrent: true,
    ...overrides,
  };
}

async function expectDomainError(promise: Promise<unknown>, code: string, status: number) {
  await expect(promise).rejects.toMatchObject({ code });
  await promise.catch((error: { getStatus(): number }) => {
    expect(error.getStatus()).toBe(status);
  });
}

describe('AttachmentAuthorizationPolicy.assertCanUpload', () => {
  function buildPolicy() {
    return new AttachmentAuthorizationPolicy();
  }

  describe('RESIDENT / SITE_MANAGER', () => {
    it.each(['RESIDENT', 'SITE_MANAGER'] as const)(
      '%s CLOSED ticket icin TICKET_UPDATE_FORBIDDEN (403) alir',
      async (role) => {
        const policy = buildPolicy();
        const lookup = jest.fn();
        await expectDomainError(
          policy.assertCanUpload(
            actor(role),
            buildTicket({ status: 'CLOSED' as never }),
            undefined,
            'ISSUE' as never,
            lookup,
          ),
          'TICKET_UPDATE_FORBIDDEN',
          403,
        );
        expect(lookup).not.toHaveBeenCalled();
      },
    );

    it.each(['RESIDENT', 'SITE_MANAGER'] as const)(
      '%s CANCELLED ticket icin TICKET_UPDATE_FORBIDDEN (403) alir',
      async (role) => {
        const policy = buildPolicy();
        await expectDomainError(
          policy.assertCanUpload(
            actor(role),
            buildTicket({ status: 'CANCELLED' as never }),
            undefined,
            'ISSUE' as never,
            jest.fn(),
          ),
          'TICKET_UPDATE_FORBIDDEN',
          403,
        );
      },
    );

    it.each(['RESIDENT', 'SITE_MANAGER'] as const)(
      '%s assignmentId gonderirse lookup YAPILMADAN ATTACHMENT_UPLOAD_NOT_ALLOWED (403) alir',
      async (role) => {
        const policy = buildPolicy();
        const lookup = jest.fn().mockResolvedValue(buildAssignment());
        await expectDomainError(
          policy.assertCanUpload(
            actor(role),
            buildTicket(),
            'assignment-1',
            'ISSUE' as never,
            lookup,
          ),
          'ATTACHMENT_UPLOAD_NOT_ALLOWED',
          403,
        );
        expect(lookup).not.toHaveBeenCalled();
      },
    );

    it.each(['RESIDENT', 'SITE_MANAGER'] as const)(
      '%s assignmentId olmadan acik ticket a izin alir',
      async (role) => {
        const policy = buildPolicy();
        await expect(
          policy.assertCanUpload(
            actor(role),
            buildTicket(),
            undefined,
            'ISSUE' as never,
            jest.fn(),
          ),
        ).resolves.toBeUndefined();
      },
    );
  });

  describe('TECHNICIAN', () => {
    it('assignmentId yoksa lookup yapilmadan ASSIGNMENT_NOT_FOUND (404) alir', async () => {
      const policy = buildPolicy();
      const lookup = jest.fn();
      await expectDomainError(
        policy.assertCanUpload(
          actor('TECHNICIAN', 'tech-1'),
          buildTicket(),
          undefined,
          'BEFORE_WORK' as never,
          lookup,
        ),
        'ASSIGNMENT_NOT_FOUND',
        404,
      );
      expect(lookup).not.toHaveBeenCalled();
    });

    it('assignment bulunamazsa ASSIGNMENT_NOT_FOUND (404) alir', async () => {
      const policy = buildPolicy();
      await expectDomainError(
        policy.assertCanUpload(
          actor('TECHNICIAN', 'tech-1'),
          buildTicket(),
          'assignment-1',
          'BEFORE_WORK' as never,
          jest.fn().mockResolvedValue(null),
        ),
        'ASSIGNMENT_NOT_FOUND',
        404,
      );
    });

    it('baska teknisyene ait assignment icin ASSIGNMENT_NOT_FOUND (404) alir', async () => {
      const policy = buildPolicy();
      await expectDomainError(
        policy.assertCanUpload(
          actor('TECHNICIAN', 'tech-2'),
          buildTicket(),
          'assignment-1',
          'BEFORE_WORK' as never,
          jest.fn().mockResolvedValue(buildAssignment({ technicianId: 'tech-1' })),
        ),
        'ASSIGNMENT_NOT_FOUND',
        404,
      );
    });

    it('isCurrent=false assignment icin ASSIGNMENT_NOT_FOUND (404) alir', async () => {
      const policy = buildPolicy();
      await expectDomainError(
        policy.assertCanUpload(
          actor('TECHNICIAN', 'tech-1'),
          buildTicket(),
          'assignment-1',
          'BEFORE_WORK' as never,
          jest.fn().mockResolvedValue(buildAssignment({ isCurrent: false })),
        ),
        'ASSIGNMENT_NOT_FOUND',
        404,
      );
    });

    it.each(['PENDING', 'REJECTED', 'CANCELLED', 'REASSIGNED', 'COMPLETED'] as const)(
      '%s durumundaki assignment icin ASSIGNMENT_NOT_FOUND (404) alir (409 degil)',
      async (status) => {
        const policy = buildPolicy();
        await expectDomainError(
          policy.assertCanUpload(
            actor('TECHNICIAN', 'tech-1'),
            buildTicket(),
            'assignment-1',
            'BEFORE_WORK' as never,
            jest.fn().mockResolvedValue(buildAssignment({ status: status as never })),
          ),
          'ASSIGNMENT_NOT_FOUND',
          404,
        );
      },
    );

    it('kendi/current/ACCEPTED assignment ama baska ticket a ait ise ATTACHMENT_ASSIGNMENT_MISMATCH (409) alir', async () => {
      const policy = buildPolicy();
      await expectDomainError(
        policy.assertCanUpload(
          actor('TECHNICIAN', 'tech-1'),
          buildTicket({ id: 'ticket-1' }),
          'assignment-1',
          'BEFORE_WORK' as never,
          jest
            .fn()
            .mockResolvedValue(
              buildAssignment({ status: 'ACCEPTED' as never, ticketId: 'ticket-OTHER' }),
            ),
        ),
        'ATTACHMENT_ASSIGNMENT_MISMATCH',
        409,
      );
    });

    it('gecerli assignment ama izinsiz attachmentType icin ATTACHMENT_TYPE_NOT_ALLOWED (422) alir', async () => {
      const policy = buildPolicy();
      await expectDomainError(
        policy.assertCanUpload(
          actor('TECHNICIAN', 'tech-1'),
          buildTicket(),
          'assignment-1',
          'DOCUMENT' as never,
          jest.fn().mockResolvedValue(buildAssignment()),
        ),
        'ATTACHMENT_TYPE_NOT_ALLOWED',
        422,
      );
    });

    it.each(['BEFORE_WORK', 'AFTER_WORK', 'MATERIAL'] as const)(
      'gecerli assignment + izinli tip (%s) icin izin verir',
      async (type) => {
        const policy = buildPolicy();
        await expect(
          policy.assertCanUpload(
            actor('TECHNICIAN', 'tech-1'),
            buildTicket(),
            'assignment-1',
            type as never,
            jest.fn().mockResolvedValue(buildAssignment()),
          ),
        ).resolves.toBeUndefined();
      },
    );
  });

  describe('OPERATIONS', () => {
    it('assignmentId olmadan ticket durumundan bagimsiz izin verir', async () => {
      const policy = buildPolicy();
      await expect(
        policy.assertCanUpload(
          actor('OPERATIONS'),
          buildTicket({ status: 'CLOSED' as never }),
          undefined,
          'DOCUMENT' as never,
          jest.fn(),
        ),
      ).resolves.toBeUndefined();
    });

    it('assignmentId verilir ve bulunamazsa ASSIGNMENT_NOT_FOUND (404) alir', async () => {
      const policy = buildPolicy();
      await expectDomainError(
        policy.assertCanUpload(
          actor('OPERATIONS'),
          buildTicket(),
          'assignment-1',
          'ISSUE' as never,
          jest.fn().mockResolvedValue(null),
        ),
        'ASSIGNMENT_NOT_FOUND',
        404,
      );
    });

    it('assignment baska ticket a aitse ATTACHMENT_ASSIGNMENT_MISMATCH (409) alir', async () => {
      const policy = buildPolicy();
      await expectDomainError(
        policy.assertCanUpload(
          actor('OPERATIONS'),
          buildTicket({ id: 'ticket-1' }),
          'assignment-1',
          'ISSUE' as never,
          jest.fn().mockResolvedValue(buildAssignment({ ticketId: 'ticket-OTHER' })),
        ),
        'ATTACHMENT_ASSIGNMENT_MISMATCH',
        409,
      );
    });

    it('assignment ayni ticket a aitse teknisyen kisitlari uygulanmadan izin verir', async () => {
      const policy = buildPolicy();
      await expect(
        policy.assertCanUpload(
          actor('OPERATIONS'),
          buildTicket({ id: 'ticket-1' }),
          'assignment-1',
          'DOCUMENT' as never,
          jest.fn().mockResolvedValue(
            buildAssignment({
              ticketId: 'ticket-1',
              status: 'COMPLETED' as never,
              isCurrent: false,
            }),
          ),
        ),
      ).resolves.toBeUndefined();
    });
  });
});
