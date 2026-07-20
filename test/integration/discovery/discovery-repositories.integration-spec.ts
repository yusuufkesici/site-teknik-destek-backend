import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import {
  startTestDatabase,
  stopTestDatabase,
  type TestDatabase,
} from '../setup/postgres-testcontainer';

// Frontend enablement plani (docs/frontend-enablement-plan.md Bolum 8):
// dort yeni salt-okunur repository metodunun gercek PostgreSQL uzerinde
// filtre/siralama/join sozlesmeleri.
describe('Discovery repository metotlari (gercek PostgreSQL)', () => {
  let testDb: TestDatabase;
  let app: INestApplication;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let prisma: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let materialRepo: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let userRepo: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let residentUnitAssignmentRepo: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let assignmentRepo: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let workflow: any;

  beforeAll(async () => {
    testDb = await startTestDatabase();

    const { AppModule } = await import('../../../src/app.module');
    const { PrismaService } = await import(
      '../../../src/infrastructure/database/prisma/prisma.service'
    );
    const { MaterialRepository } = await import(
      '../../../src/modules/materials/repositories/material.repository'
    );
    const { UserRepository } = await import(
      '../../../src/modules/users/repositories/user.repository'
    );
    const { ResidentUnitAssignmentRepository } = await import(
      '../../../src/modules/memberships/repositories/resident-unit-assignment.repository'
    );
    const { AssignmentRepository } = await import(
      '../../../src/modules/assignments/repositories/assignment.repository'
    );
    const { TicketAssignmentWorkflowService } = await import(
      '../../../src/modules/assignments/services/ticket-assignment-workflow.service'
    );

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();

    prisma = app.get(PrismaService);
    materialRepo = app.get(MaterialRepository);
    userRepo = app.get(UserRepository);
    residentUnitAssignmentRepo = app.get(ResidentUnitAssignmentRepository);
    assignmentRepo = app.get(AssignmentRepository);
    workflow = app.get(TicketAssignmentWorkflowService);
  }, 120000);

  afterAll(async () => {
    await app.close();
    await stopTestDatabase(testDb);
  });

  function randomPhone(prefix: string): string {
    return `+9055${prefix}${Math.floor(Math.random() * 900000 + 100000)}`;
  }

  async function createSiteWithUnit(prefix: string) {
    const site = await prisma.facility.create({
      data: { type: 'SITE', name: `Site ${prefix}`, code: `DSC-${prefix}` },
    });
    const block = await prisma.facility.create({
      data: { type: 'BLOCK', name: 'Blok 1', code: 'B1', parentId: site.id, siteId: site.id },
    });
    const unit = await prisma.facility.create({
      data: { type: 'UNIT', name: 'Daire 1', code: 'D-1', parentId: block.id, siteId: site.id },
    });
    return { site, block, unit };
  }

  describe('MaterialRepository.listActive', () => {
    it('yalniz aktif+silinmemis kayitlari createdAt DESC dondurur ve cursor sayfalar', async () => {
      const active1 = await prisma.material.create({
        data: {
          name: 'Aktif Eski',
          code: 'DSC-M1',
          unit: 'adet',
          createdAt: new Date('2026-01-01T00:00:00.000Z'),
        },
      });
      const active2 = await prisma.material.create({
        data: {
          name: 'Aktif Yeni',
          code: 'DSC-M2',
          unit: 'adet',
          createdAt: new Date('2026-02-01T00:00:00.000Z'),
        },
      });
      const inactive = await prisma.material.create({
        data: { name: 'Pasif', code: 'DSC-M3', unit: 'adet', isActive: false },
      });
      const deleted = await prisma.material.create({
        data: { name: 'Silinmis', code: 'DSC-M4', unit: 'adet', deletedAt: new Date() },
      });

      const rows = await materialRepo.listActive(prisma, { cursor: null, limit: 50 });
      const ids = rows.map((row: { id: string }) => row.id);

      expect(ids).toContain(active1.id);
      expect(ids).toContain(active2.id);
      expect(ids).not.toContain(inactive.id);
      expect(ids).not.toContain(deleted.id);
      expect(ids.indexOf(active2.id)).toBeLessThan(ids.indexOf(active1.id)); // createdAt DESC

      // limit+1 sozlesmesi: limit=1 ile en az 2 kayit varken 2 satir doner.
      const firstPage = await materialRepo.listActive(prisma, { cursor: null, limit: 1 });
      expect(firstPage.length).toBe(2);

      // Cursor: en yeni kaydin arkasindan eski kayit gelir.
      const afterNewest = await materialRepo.listActive(prisma, {
        cursor: { createdAt: active2.createdAt.toISOString(), id: active2.id },
        limit: 50,
      });
      const afterIds = afterNewest.map((row: { id: string }) => row.id);
      expect(afterIds).toContain(active1.id);
      expect(afterIds).not.toContain(active2.id);
    });
  });

  describe('UserRepository.listActiveTechnicianSummaries', () => {
    it('yalniz aktif+silinmemis TECHNICIAN kullanicilarini telefon icermeyen ozetle doner', async () => {
      const activeTech = await prisma.user.create({
        data: {
          phoneNumber: randomPhone('71'),
          firstName: 'Aktif',
          lastName: 'Teknisyen',
          role: 'TECHNICIAN',
        },
      });
      const inactiveTech = await prisma.user.create({
        data: {
          phoneNumber: randomPhone('72'),
          firstName: 'Pasif',
          lastName: 'Teknisyen',
          role: 'TECHNICIAN',
          isActive: false,
        },
      });
      const deletedTech = await prisma.user.create({
        data: {
          phoneNumber: randomPhone('73'),
          firstName: 'Silinmis',
          lastName: 'Teknisyen',
          role: 'TECHNICIAN',
          deletedAt: new Date(),
        },
      });
      const opsUser = await prisma.user.create({
        data: {
          phoneNumber: randomPhone('74'),
          firstName: 'Ops',
          lastName: 'Kullanici',
          role: 'OPERATIONS',
        },
      });

      const rows = await userRepo.listActiveTechnicianSummaries(prisma);
      const ids = rows.map((row: { id: string }) => row.id);

      expect(ids).toContain(activeTech.id);
      expect(ids).not.toContain(inactiveTech.id);
      expect(ids).not.toContain(deletedTech.id);
      expect(ids).not.toContain(opsUser.id);

      for (const row of rows) {
        expect(row).not.toHaveProperty('phoneNumber');
        expect(row).not.toHaveProperty('tokenVersion');
        expect(Object.keys(row).sort()).toEqual(['firstName', 'id', 'lastName']);
      }
    });
  });

  describe('ResidentUnitAssignmentRepository.listActiveForUserWithUnit', () => {
    it('yalniz ilgili kullanicinin aktif kayitlarini unit ozetiyle doner', async () => {
      const { site, unit } = await createSiteWithUnit('U1');
      const { unit: otherUnit } = await createSiteWithUnit('U2');

      const owner = await prisma.user.create({
        data: { phoneNumber: randomPhone('75'), firstName: 'Sakin', lastName: 'Bir', role: 'RESIDENT' },
      });
      const otherUser = await prisma.user.create({
        data: { phoneNumber: randomPhone('76'), firstName: 'Sakin', lastName: 'Iki', role: 'RESIDENT' },
      });

      const activeOwn = await prisma.residentUnitAssignment.create({
        data: { userId: owner.id, unitId: unit.id, isPrimary: true, isActive: true },
      });
      const inactiveOwn = await prisma.residentUnitAssignment.create({
        data: {
          userId: owner.id,
          unitId: otherUnit.id,
          isPrimary: false,
          isActive: false,
          endsAt: new Date(),
        },
      });
      const foreign = await prisma.residentUnitAssignment.create({
        data: { userId: otherUser.id, unitId: otherUnit.id, isPrimary: true, isActive: true },
      });

      const rows = await residentUnitAssignmentRepo.listActiveForUserWithUnit(prisma, owner.id);
      const ids = rows.map((row: { id: string }) => row.id);

      expect(ids).toEqual([activeOwn.id]);
      expect(ids).not.toContain(inactiveOwn.id);
      expect(ids).not.toContain(foreign.id);

      expect(rows[0].unit).toEqual({
        id: unit.id,
        name: 'Daire 1',
        code: 'D-1',
        siteId: site.id,
      });
      expect(rows[0]).not.toHaveProperty('isActive');
      expect(rows[0]).not.toHaveProperty('endsAt');
    });
  });

  describe('AssignmentRepository.findCurrentByTicketId', () => {
    it('atamadan sonra current satiri, reassign sonrasi yenisini, current kalmayinca null doner', async () => {
      const { site, unit } = await createSiteWithUnit('A1');
      const ops = await prisma.user.create({
        data: { phoneNumber: randomPhone('77'), firstName: 'Ops', lastName: 'Bir', role: 'OPERATIONS' },
      });
      const resident = await prisma.user.create({
        data: { phoneNumber: randomPhone('78'), firstName: 'Sakin', lastName: 'Uc', role: 'RESIDENT' },
      });
      const tech1 = await prisma.user.create({
        data: { phoneNumber: randomPhone('79'), firstName: 'Tek', lastName: 'Bir', role: 'TECHNICIAN' },
      });
      const tech2 = await prisma.user.create({
        data: { phoneNumber: randomPhone('80'), firstName: 'Tek', lastName: 'Iki', role: 'TECHNICIAN' },
      });

      const ticket = await prisma.ticket.create({
        data: {
          code: `TKT-DSC-${Math.floor(Math.random() * 1_000_000)}`,
          createdByUserId: resident.id,
          siteId: site.id,
          facilityId: unit.id,
          title: 'Discovery ariza',
          description: 'Current assignment kesif testi icin kayit.',
          category: 'ELECTRICAL',
          source: 'RESIDENT',
          status: 'TRIAGED',
        },
      });

      const opsActor = { id: ops.id, role: 'OPERATIONS', sessionId: 's', tokenVersion: 0 };

      expect(await assignmentRepo.findCurrentByTicketId(prisma, ticket.id)).toBeNull();

      const first = await workflow.assignTechnician(opsActor, ticket.id, {
        technicianId: tech1.id,
      });
      const currentAfterAssign = await assignmentRepo.findCurrentByTicketId(prisma, ticket.id);
      expect(currentAfterAssign).toMatchObject({
        id: first.id,
        technicianId: tech1.id,
        isCurrent: true,
      });

      const second = await workflow.assignTechnician(opsActor, ticket.id, {
        technicianId: tech2.id,
      });
      const currentAfterReassign = await assignmentRepo.findCurrentByTicketId(prisma, ticket.id);
      expect(currentAfterReassign).toMatchObject({
        id: second.id,
        technicianId: tech2.id,
        isCurrent: true,
      });

      const superseded = await prisma.assignment.findUnique({ where: { id: first.id } });
      expect(superseded).toMatchObject({ assignmentStatus: 'REASSIGNED', isCurrent: false });

      await prisma.assignment.update({ where: { id: second.id }, data: { isCurrent: false } });
      expect(await assignmentRepo.findCurrentByTicketId(prisma, ticket.id)).toBeNull();
    });
  });
});
