import { randomUUID } from 'node:crypto';
import { mkdirSync, readdirSync, writeFileSync, existsSync } from 'node:fs';
import * as path from 'node:path';
import type { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import {
  startTestDatabase,
  stopTestDatabase,
  type TestDatabase,
} from '../setup/postgres-testcontainer';

const JPEG_FIXTURE = Buffer.concat([
  Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]),
  Buffer.from('JFIF fixture content for Faz 6 integration test', 'ascii'),
]);

describe('Attachments - upload/list/download (gercek PostgreSQL)', () => {
  let testDb: TestDatabase;
  let app: INestApplication;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let prisma: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let ticketService: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let facilityService: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let workflow: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let attachmentService: any;
  let localPath: string;
  let tmpDir: string;

  beforeAll(async () => {
    testDb = await startTestDatabase();

    const { AppModule } = await import('../../../src/app.module');
    const { PrismaService } = await import(
      '../../../src/infrastructure/database/prisma/prisma.service'
    );
    const { TicketService } = await import('../../../src/modules/tickets/services/ticket.service');
    const { FacilityService } = await import(
      '../../../src/modules/facilities/services/facility.service'
    );
    const { TicketAssignmentWorkflowService } = await import(
      '../../../src/modules/assignments/services/ticket-assignment-workflow.service'
    );
    const { AttachmentService } = await import(
      '../../../src/modules/attachments/services/attachment.service'
    );

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();

    prisma = app.get(PrismaService);
    ticketService = app.get(TicketService);
    facilityService = app.get(FacilityService);
    workflow = app.get(TicketAssignmentWorkflowService);
    attachmentService = app.get(AttachmentService);

    const config = app.get(ConfigService);
    localPath = config.getOrThrow<string>('storage.localPath');
    tmpDir = path.join(localPath, 'tmp');
    mkdirSync(tmpDir, { recursive: true });
  }, 120000);

  afterAll(async () => {
    await app.close();
    await stopTestDatabase(testDb);
  });

  function randomPhone(prefix: string): string {
    return `+9055${prefix}${Math.floor(Math.random() * 900000 + 100000)}`;
  }

  function makeUploadFile(overrides: Partial<Express.Multer.File> = {}): Express.Multer.File {
    const filePath = path.join(tmpDir, randomUUID());
    writeFileSync(filePath, JPEG_FIXTURE);
    return {
      fieldname: 'file',
      originalname: 'foto.jpg',
      encoding: '7bit',
      mimetype: 'image/jpeg',
      size: JPEG_FIXTURE.length,
      destination: tmpDir,
      filename: path.basename(filePath),
      path: filePath,
      buffer: Buffer.alloc(0),
      stream: undefined as never,
      ...overrides,
    } as Express.Multer.File;
  }

  async function createOpsActor() {
    const user = await prisma.user.create({
      data: { phoneNumber: randomPhone('71'), firstName: 'Ops', lastName: 'Actor', role: 'OPERATIONS' },
    });
    return { id: user.id, role: 'OPERATIONS', sessionId: 's', tokenVersion: 0 } as const;
  }

  async function createTechnicianActor(prefix: string) {
    const user = await prisma.user.create({
      data: {
        phoneNumber: randomPhone(prefix),
        firstName: 'Tekni',
        lastName: 'Syen',
        role: 'TECHNICIAN',
      },
    });
    return { id: user.id, role: 'TECHNICIAN', sessionId: 's', tokenVersion: 0 } as const;
  }

  async function createResidentActor(siteId: string, unitId: string, prefix: string) {
    const user = await prisma.user.create({
      data: { phoneNumber: randomPhone(prefix), firstName: 'Sakin', lastName: 'Bir', role: 'RESIDENT' },
    });
    await prisma.siteMembership.create({
      data: { userId: user.id, siteId, membershipRole: 'RESIDENT', isActive: true },
    });
    await prisma.residentUnitAssignment.create({
      data: { userId: user.id, unitId, isPrimary: true, isActive: true },
    });
    return { id: user.id, role: 'RESIDENT', sessionId: 's', tokenVersion: 0 } as const;
  }

  async function createSiteWithContract(prefix: string, opsActor: { id: string }) {
    const site = await facilityService.createSite({ name: `Site ${prefix}`, code: `AT-${prefix}` }, opsActor);
    const block = await facilityService.createBlock(site.id, { name: 'Blok 1', code: 'B1' }, opsActor);
    const unit = await facilityService.createUnit(block.id, { code: 'D-1' }, opsActor);

    const today = new Date();
    const start = new Date(today);
    start.setDate(start.getDate() - 30);
    const end = new Date(today);
    end.setDate(end.getDate() + 30);

    await prisma.contract.create({
      data: {
        siteId: site.id,
        contractNumber: `AT-CN-${prefix}-${Math.floor(Math.random() * 1_000_000)}`,
        startDate: start,
        endDate: end,
        monthlyFee: '1000.00',
        billingDay: 1,
        status: 'ACTIVE',
        standardResponseTargetHours: 48,
        emergencyCoverage: true,
        createdByUserId: opsActor.id,
      },
    });

    return { site, unit };
  }

  async function createTriagedTicket(
    opsActor: { id: string; role: string },
    resident: { id: string; role: string },
    unitId: string,
  ) {
    const created = await ticketService.create(resident, {
      facilityId: unitId,
      title: 'Su tesisati arizasi',
      description: 'Musluk damlatiyor, tamir gerekli',
      category: 'PLUMBING',
    });
    return ticketService.changeStatus(opsActor, created.id, { toStatus: 'TRIAGED' });
  }

  it('gecerli JPEG upload sonrasi metadata dogru ticketId ile kaydedilir', async () => {
    const opsActor = await createOpsActor();
    const { site, unit } = await createSiteWithContract('U1', opsActor);
    const resident = await createResidentActor(site.id, unit.id, '10');
    const ticket = await createTriagedTicket(opsActor, resident, unit.id);

    const created = await attachmentService.upload(
      resident,
      ticket.id,
      { attachmentType: 'ISSUE' },
      makeUploadFile(),
    );

    expect(created.ticketId).toBe(ticket.id);
    expect(created.assignmentId).toBeNull();
    expect(created.mimeType).toBe('image/jpeg');
    expect(created.storageProvider).toBe('local');
    expect(existsSync(path.join(localPath, created.storageKey))).toBe(true);

    const row = await prisma.ticketAttachment.findUniqueOrThrow({ where: { id: created.id } });
    expect(row.ticketId).toBe(ticket.id);
  });

  it('cross-site erisim (baska sitenin residenti) TICKET_NOT_FOUND (404) alir', async () => {
    const opsActor = await createOpsActor();
    const { site: siteA, unit: unitA } = await createSiteWithContract('U2A', opsActor);
    const { site: siteB, unit: unitB } = await createSiteWithContract('U2B', opsActor);
    const residentA = await createResidentActor(siteA.id, unitA.id, '20');
    const residentB = await createResidentActor(siteB.id, unitB.id, '21');
    const ticket = await createTriagedTicket(opsActor, residentA, unitA.id);

    await expect(
      attachmentService.upload(residentB, ticket.id, { attachmentType: 'ISSUE' }, makeUploadFile()),
    ).rejects.toMatchObject({ code: 'TICKET_NOT_FOUND' });
  });

  it('baska teknisyenin assignment i ile upload ASSIGNMENT_NOT_FOUND (404) alir', async () => {
    const opsActor = await createOpsActor();
    const { site, unit } = await createSiteWithContract('U3', opsActor);
    const resident = await createResidentActor(site.id, unit.id, '30');
    const tech1 = await createTechnicianActor('31');
    const tech2 = await createTechnicianActor('32');
    const ticket = await createTriagedTicket(opsActor, resident, unit.id);
    // tech2 once atanir (ticket'a okuma erisimi kazanir - existsAssignmentForTechnician
    // isCurrent filtrelemez), sonra tech1'e reassign edilir. tech2 artik kendi eski
    // (REASSIGNED) atamasi uzerinden ticket'i okuyabilir ama tech1'in YENİ atamasinin
    // sahibi degildir.
    const tech2OldAssignment = await workflow.assignTechnician(opsActor, ticket.id, {
      technicianId: tech2.id,
    });
    const tech1Assignment = await workflow.assignTechnician(opsActor, ticket.id, {
      technicianId: tech1.id,
    });
    await workflow.accept(tech1, tech1Assignment.id);
    expect(tech2OldAssignment.id).not.toBe(tech1Assignment.id);

    await expect(
      attachmentService.upload(
        tech2,
        ticket.id,
        { attachmentType: 'BEFORE_WORK', assignmentId: tech1Assignment.id },
        makeUploadFile(),
      ),
    ).rejects.toMatchObject({ code: 'ASSIGNMENT_NOT_FOUND' });
  });

  it('isCurrent=false (reassign edilmis) assignment ile upload ASSIGNMENT_NOT_FOUND (404) alir', async () => {
    const opsActor = await createOpsActor();
    const { site, unit } = await createSiteWithContract('U4', opsActor);
    const resident = await createResidentActor(site.id, unit.id, '40');
    const tech1 = await createTechnicianActor('41');
    const tech2 = await createTechnicianActor('42');
    const ticket = await createTriagedTicket(opsActor, resident, unit.id);
    const firstAssignment = await workflow.assignTechnician(opsActor, ticket.id, {
      technicianId: tech1.id,
    });
    // Reassign - firstAssignment artik isCurrent=false olur.
    await workflow.assignTechnician(opsActor, ticket.id, { technicianId: tech2.id });

    await expect(
      attachmentService.upload(
        tech1,
        ticket.id,
        { attachmentType: 'BEFORE_WORK', assignmentId: firstAssignment.id },
        makeUploadFile(),
      ),
    ).rejects.toMatchObject({ code: 'ASSIGNMENT_NOT_FOUND' });
  });

  it('COMPLETED durumundaki assignment ile upload ASSIGNMENT_NOT_FOUND (404) alir (409 degil)', async () => {
    const opsActor = await createOpsActor();
    const { site, unit } = await createSiteWithContract('U5', opsActor);
    const resident = await createResidentActor(site.id, unit.id, '50');
    const tech1 = await createTechnicianActor('51');
    const ticket = await createTriagedTicket(opsActor, resident, unit.id);
    const assignment = await workflow.assignTechnician(opsActor, ticket.id, { technicianId: tech1.id });
    await workflow.accept(tech1, assignment.id);
    await workflow.applyStatusEvent(tech1, assignment.id, { event: 'EN_ROUTE' });
    await workflow.applyStatusEvent(tech1, assignment.id, { event: 'ARRIVED' });
    await workflow.applyStatusEvent(tech1, assignment.id, { event: 'START' });
    await workflow.applyStatusEvent(tech1, assignment.id, { event: 'COMPLETE' });

    await expect(
      attachmentService.upload(
        tech1,
        ticket.id,
        { attachmentType: 'AFTER_WORK', assignmentId: assignment.id },
        makeUploadFile(),
      ),
    ).rejects.toMatchObject({ code: 'ASSIGNMENT_NOT_FOUND' });
  });

  it('kendi/current/ACTIVE assignment ama baska ticket a ait ise ATTACHMENT_ASSIGNMENT_MISMATCH (409) alir', async () => {
    const opsActor = await createOpsActor();
    const { site, unit } = await createSiteWithContract('U6', opsActor);
    const resident = await createResidentActor(site.id, unit.id, '60');
    const tech1 = await createTechnicianActor('61');
    const tech3 = await createTechnicianActor('63');
    const ticketA = await createTriagedTicket(opsActor, resident, unit.id);
    const ticketB = await createTriagedTicket(opsActor, resident, unit.id);
    const assignmentOnA = await workflow.assignTechnician(opsActor, ticketA.id, {
      technicianId: tech1.id,
    });
    await workflow.accept(tech1, assignmentOnA.id);

    // tech1'e ticketB uzerinde okuma erisimi kazandirmak icin once tech1
    // atanir, sonra tech3'e reassign edilir (tech1'in ticketB'deki atamasi
    // REASSIGNED olur ama existsAssignmentForTechnician hala true doner).
    await workflow.assignTechnician(opsActor, ticketB.id, { technicianId: tech1.id });
    await workflow.assignTechnician(opsActor, ticketB.id, { technicianId: tech3.id });

    await expect(
      attachmentService.upload(
        tech1,
        ticketB.id,
        { attachmentType: 'BEFORE_WORK', assignmentId: assignmentOnA.id },
        makeUploadFile(),
      ),
    ).rejects.toMatchObject({ code: 'ATTACHMENT_ASSIGNMENT_MISMATCH' });
  });

  it('composite FK: (assignment_id, ticket_id) uyusmayan dogrudan SQL insert DB seviyesinde reddedilir', async () => {
    const opsActor = await createOpsActor();
    const { site, unit } = await createSiteWithContract('U7', opsActor);
    const resident = await createResidentActor(site.id, unit.id, '70');
    const tech1 = await createTechnicianActor('71');
    const ticketA = await createTriagedTicket(opsActor, resident, unit.id);
    const ticketB = await createTriagedTicket(opsActor, resident, unit.id);
    const assignmentOnA = await workflow.assignTechnician(opsActor, ticketA.id, {
      technicianId: tech1.id,
    });

    await expect(
      prisma.$executeRaw`
        INSERT INTO ticket_attachments (
          id, ticket_id, assignment_id, uploaded_by_user_id, attachment_type,
          storage_provider, storage_key, original_file_name, mime_type, file_size, checksum
        ) VALUES (
          gen_random_uuid(), ${ticketB.id}::uuid, ${assignmentOnA.id}::uuid, ${tech1.id}::uuid, 'BEFORE_WORK',
          'local', 'attachments/does-not-matter', 'x.jpg', 'image/jpeg', 10, ${'0'.repeat(64)}
        )
      `,
    ).rejects.toThrow();
  });

  it('listeleme cursor pagination ile dogru sirada doner', async () => {
    const opsActor = await createOpsActor();
    const { site, unit } = await createSiteWithContract('U8', opsActor);
    const resident = await createResidentActor(site.id, unit.id, '80');
    const ticket = await createTriagedTicket(opsActor, resident, unit.id);

    await attachmentService.upload(
      resident,
      ticket.id,
      { attachmentType: 'ISSUE' },
      makeUploadFile(),
    );
    await attachmentService.upload(
      resident,
      ticket.id,
      { attachmentType: 'ISSUE' },
      makeUploadFile(),
    );

    const page = await attachmentService.list(resident, ticket.id, {});
    expect(page.items.length).toBe(2);
  });

  it('DB insert basarisizliginda finalize edilmis dosya gercek diskten compensating delete ile silinir, orphan metadata olusmaz', async () => {
    const opsActor = await createOpsActor();
    const { site, unit } = await createSiteWithContract('U9', opsActor);
    const resident = await createResidentActor(site.id, unit.id, '90');
    const ticket = await createTriagedTicket(opsActor, resident, unit.id);

    // OPERATIONS rolu TicketAuthorizationPolicy'den kosulsuz gecer ve
    // AttachmentAuthorizationPolicy assignment'siz OPERATIONS'a izin verir -
    // fakat uploaded_by_user_id, users tablosunda OLMAYAN bir UUID oldugu
    // icin DB insert FK ihlaliyle basarisiz olur. Boylece finalize BASARILI
    // olduktan sonra gercek bir DB hatasi tetiklenir ve compensating delete
    // gercek dosya sistemi uzerinde dogrulanir (plan Bolum 9 adim 5/13).
    const ghostOpsActor = {
      id: randomUUID(),
      role: 'OPERATIONS',
      sessionId: 's',
      tokenVersion: 0,
    } as const;

    const attachmentsDir = path.join(localPath, 'attachments');
    mkdirSync(attachmentsDir, { recursive: true });
    const filesBefore = new Set(readdirSync(attachmentsDir));
    const attachmentRowsBefore = await prisma.ticketAttachment.count({
      where: { ticketId: ticket.id },
    });

    await expect(
      attachmentService.upload(
        ghostOpsActor,
        ticket.id,
        { attachmentType: 'DOCUMENT' },
        makeUploadFile(),
      ),
    ).rejects.toThrow();

    // Orphan metadata yok:
    const attachmentRowsAfter = await prisma.ticketAttachment.count({
      where: { ticketId: ticket.id },
    });
    expect(attachmentRowsAfter).toBe(attachmentRowsBefore);

    // Orphan final dosya yok (finalize'in tasidigi yeni dosya silinmis olmali):
    const filesAfter = readdirSync(attachmentsDir).filter((f) => !filesBefore.has(f));
    expect(filesAfter).toHaveLength(0);
  });
});
