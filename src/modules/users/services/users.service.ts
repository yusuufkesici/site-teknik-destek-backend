import { HttpStatus, Injectable } from '@nestjs/common';
import { ERROR_CODES } from '../../../common/constants/error-codes.constant';
import { DOMAIN_AUDIT_ACTIONS } from '../../../common/constants/domain-audit-actions.constant';
import { DomainError } from '../../../common/errors/domain-error';
import type { AuthenticatedUser } from '../../../common/types/authenticated-user.type';
import { maskPhone } from '../../../common/utils/mask.util';
import {
  buildPage,
  decodeCursor,
  type PaginatedResult,
} from '../../../common/utils/pagination.util';
import { isUniqueConstraintViolation } from '../../../common/utils/prisma-error.util';
import { UserRole } from '../../../generated/prisma-client/enums';
import { AuditWriter } from '../../../infrastructure/audit/audit-writer.service';
import { PrismaService } from '../../../infrastructure/database/prisma/prisma.service';
import { AuthSessionRevocationService } from '../../auth/services/auth-session-revocation.service';
import { FacilityRepository } from '../../facilities/repositories/facility.repository';
import { MembershipQueryService } from '../../memberships/membership-query.service';
import { ResidentUnitAssignmentRepository } from '../../memberships/repositories/resident-unit-assignment.repository';
import { SiteMembershipRepository } from '../../memberships/repositories/site-membership.repository';
import type { CreateResidentDto } from '../dto/create-resident.dto';
import type { ListSiteUsersQueryDto } from '../dto/list-site-users-query.dto';
import type { UpdateUserDto } from '../dto/update-user.dto';
import type { UserRow } from '../repositories/user.repository';
import { UserRepository } from '../repositories/user.repository';
import { UserAccessPolicy } from './user-access.policy';

const DEFAULT_PAGE_LIMIT = 20;

// Onaylanan Faz 3 plani Bolum 9/10: resident onboarding, global profil
// guncelleme, site-scoped/global pasiflestirme ve site kullanici listesi
// orkestrasyonu. Her yazma islemi tek transaction'da audit'iyle birlikte
// yazilir; P2002 transaction disinda yakalanip domain hatasina cevrilir.
@Injectable()
export class UsersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly userRepo: UserRepository,
    private readonly accessPolicy: UserAccessPolicy,
    private readonly membershipQuery: MembershipQueryService,
    private readonly siteMembershipRepo: SiteMembershipRepository,
    private readonly residentUnitAssignmentRepo: ResidentUnitAssignmentRepository,
    private readonly facilityRepo: FacilityRepository,
    private readonly authSessionRevocation: AuthSessionRevocationService,
    private readonly audit: AuditWriter,
  ) {}

  async onboardResident(
    siteId: string,
    dto: CreateResidentDto,
    actor: AuthenticatedUser,
  ): Promise<UserRow> {
    try {
      return await this.prisma.$transaction(async (tx) => {
        // Duzeltme #4: eszamanlilik stratejisi - transaction-scoped advisory
        // lock, telefon numarasi uzerinden. Ayni telefonla gelen paralel
        // onboarding istekleri burada serilesir.
        await this.userRepo.acquirePhoneLock(tx, dto.phoneNumber);

        const unit = await this.facilityRepo.findAliveById(tx, dto.unitId);
        if (!unit || unit.type !== 'UNIT' || unit.siteId !== siteId) {
          throw new DomainError(
            ERROR_CODES.UNIT_NOT_FOUND,
            HttpStatus.NOT_FOUND,
            'Daire bulunamadi.',
          );
        }

        const existing = await this.userRepo.findByPhone(tx, dto.phoneNumber);
        let user: UserRow;
        if (!existing) {
          user = await this.userRepo.create(tx, {
            phoneNumber: dto.phoneNumber,
            firstName: dto.firstName,
            lastName: dto.lastName,
            role: UserRole.RESIDENT,
          });
        } else if (existing.role === UserRole.RESIDENT && existing.deletedAt === null) {
          // Uc rev: mevcut kullanicinin global profili (firstName/lastName)
          // onboarding'de SESSIZCE guncellenmez.
          user = existing;
        } else {
          throw new DomainError(
            ERROR_CODES.USER_PHONE_ALREADY_EXISTS,
            HttpStatus.CONFLICT,
            'Bu telefon numarasi baska bir kullaniciya ait.',
          );
        }

        await this.siteMembershipRepo.upsertActive(tx, {
          userId: user.id,
          siteId,
          membershipRole: 'RESIDENT',
        });

        const existingAssignment = await this.residentUnitAssignmentRepo.findActiveForUser(
          tx,
          user.id,
        );
        if (existingAssignment) {
          if (existingAssignment.unitId !== dto.unitId) {
            throw new DomainError(
              ERROR_CODES.RESIDENT_UNIT_ASSIGNMENT_CONFLICT,
              HttpStatus.CONFLICT,
              'Kullanicinin zaten farkli bir dairede aktif ikameti var.',
            );
          }
        } else {
          await this.residentUnitAssignmentRepo.create(tx, {
            userId: user.id,
            unitId: dto.unitId,
            isPrimary: dto.isPrimary ?? true,
          });
        }

        await this.audit.log(tx, {
          action: DOMAIN_AUDIT_ACTIONS.RESIDENT_ONBOARDED,
          actorUserId: actor.id,
          entityType: 'User',
          entityId: user.id,
          siteId,
          metadata: { unitId: dto.unitId },
        });

        return user;
      });
    } catch (error) {
      if (isUniqueConstraintViolation(error)) {
        throw new DomainError(
          ERROR_CODES.CONFLICT,
          HttpStatus.CONFLICT,
          'Eszamanli istek cakismasi.',
        );
      }
      throw error;
    }
  }

  async update(
    targetUserId: string,
    dto: UpdateUserDto,
    actor: AuthenticatedUser,
  ): Promise<UserRow> {
    if (actor.role === UserRole.OPERATIONS && dto.phoneNumber !== undefined) {
      throw new DomainError(
        ERROR_CODES.FORBIDDEN,
        HttpStatus.FORBIDDEN,
        'OPERATIONS rolu telefon numarasi degistiremez.',
      );
    }

    try {
      return await this.prisma.$transaction(async (tx) => {
        const target = await this.userRepo.findAliveById(tx, targetUserId);
        if (!target) {
          throw new DomainError(
            ERROR_CODES.USER_NOT_FOUND,
            HttpStatus.NOT_FOUND,
            'Kullanici bulunamadi.',
          );
        }

        if (actor.role === UserRole.SITE_MANAGER) {
          await this.accessPolicy.assertSiteManagerCanUpdateGlobalProfile(actor, target, tx);
        } else {
          await this.accessPolicy.assertManagerCanAccessResident(actor, target, tx);
        }

        const wantsPhoneChange = dto.phoneNumber !== undefined;
        const wantsNameChange = dto.firstName !== undefined || dto.lastName !== undefined;

        let updated = target;
        if (wantsPhoneChange || wantsNameChange) {
          updated = await this.userRepo.update(tx, target.id, {
            firstName: dto.firstName,
            lastName: dto.lastName,
            phoneNumber: dto.phoneNumber,
            incrementTokenVersion: wantsPhoneChange,
          });
        }

        if (wantsPhoneChange && dto.phoneNumber) {
          await this.audit.log(tx, {
            action: DOMAIN_AUDIT_ACTIONS.USER_PHONE_CHANGED,
            actorUserId: actor.id,
            entityType: 'User',
            entityId: target.id,
            metadata: {
              oldPhoneMasked: maskPhone(target.phoneNumber),
              newPhoneMasked: maskPhone(dto.phoneNumber),
            },
          });
        }

        if (wantsNameChange) {
          const changedFields = [
            dto.firstName !== undefined ? 'firstName' : null,
            dto.lastName !== undefined ? 'lastName' : null,
          ].filter((field): field is string => field !== null);

          await this.audit.log(tx, {
            action: DOMAIN_AUDIT_ACTIONS.USER_UPDATED,
            actorUserId: actor.id,
            entityType: 'User',
            entityId: target.id,
            metadata: { changedFields },
          });
        }

        return updated;
      });
    } catch (error) {
      if (isUniqueConstraintViolation(error)) {
        throw new DomainError(
          ERROR_CODES.USER_PHONE_ALREADY_EXISTS,
          HttpStatus.CONFLICT,
          'Bu telefon numarasi baska bir kullaniciya ait.',
        );
      }
      throw error;
    }
  }

  // Duzeltme #1: site-scoped pasiflestirme - User.isActive'e KESINLIKLE
  // dokunulmaz, hicbir refresh session global olarak revoke edilmez.
  async deactivateSiteMembership(
    siteId: string,
    targetUserId: string,
    reason: string,
    actor: AuthenticatedUser,
  ): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const target = await this.userRepo.findAliveById(tx, targetUserId);
      if (!target) {
        throw new DomainError(
          ERROR_CODES.USER_NOT_FOUND,
          HttpStatus.NOT_FOUND,
          'Kullanici bulunamadi.',
        );
      }

      await this.accessPolicy.assertManagerCanAccessResident(actor, target, tx);

      const hasMembership = await this.membershipQuery.hasActiveSiteMembership(target.id, siteId, {
        client: tx,
      });
      if (!hasMembership) {
        throw new DomainError(
          ERROR_CODES.USER_NOT_FOUND,
          HttpStatus.NOT_FOUND,
          'Kullanici bulunamadi.',
        );
      }

      const membershipCount = await this.siteMembershipRepo.deactivateForSite(tx, {
        userId: target.id,
        siteId,
      });
      const assignmentCount = await this.residentUnitAssignmentRepo.deactivateAllForUserInSite(tx, {
        userId: target.id,
        siteId,
      });

      const remainingActiveSiteMemberships = (
        await this.membershipQuery.listActiveMembershipsForUser(target.id, { client: tx })
      ).length;

      await this.audit.log(tx, {
        action: DOMAIN_AUDIT_ACTIONS.SITE_MEMBERSHIP_DEACTIVATED,
        actorUserId: actor.id,
        entityType: 'User',
        entityId: target.id,
        siteId,
        metadata: { reason, membershipCount, assignmentCount, remainingActiveSiteMemberships },
      });
    });
  }

  // Duzeltme #1/#3: global pasiflestirme - yalniz OPERATIONS (controller
  // seviyesinde @Roles ile kilitli). AuthSessionRevocationService portu
  // uzerinden AYNI transaction'da tum refresh session'lar iptal edilir.
  async deactivateGlobally(
    targetUserId: string,
    reason: string,
    actor: AuthenticatedUser,
  ): Promise<UserRow> {
    return this.prisma.$transaction(async (tx) => {
      const target = await this.userRepo.findAliveById(tx, targetUserId);
      if (!target) {
        throw new DomainError(
          ERROR_CODES.USER_NOT_FOUND,
          HttpStatus.NOT_FOUND,
          'Kullanici bulunamadi.',
        );
      }

      const updated = await this.userRepo.deactivateGlobally(tx, target.id);
      await this.authSessionRevocation.revokeAllForUser(tx, target.id);

      await this.audit.log(tx, {
        action: DOMAIN_AUDIT_ACTIONS.USER_DEACTIVATED,
        actorUserId: actor.id,
        entityType: 'User',
        entityId: target.id,
        metadata: { reason },
      });

      return updated;
    });
  }

  // Duzeltme #9: SiteScopeGuard site'in var oldugunu dogrulamaz; bu servis
  // metodu OPERATIONS icin de site varligini acikca kontrol eder.
  async listBySite(
    siteId: string,
    query: ListSiteUsersQueryDto,
  ): Promise<PaginatedResult<UserRow>> {
    const site = await this.facilityRepo.findAliveById(this.prisma, siteId);
    if (!site || site.type !== 'SITE') {
      throw new DomainError(ERROR_CODES.SITE_NOT_FOUND, HttpStatus.NOT_FOUND, 'Site bulunamadi.');
    }

    let cursor = null;
    if (query.cursor) {
      cursor = decodeCursor(query.cursor);
      if (!cursor) {
        throw new DomainError(
          ERROR_CODES.VALIDATION_ERROR,
          HttpStatus.UNPROCESSABLE_ENTITY,
          'Gecersiz cursor.',
        );
      }
    }

    const limit = query.limit ?? DEFAULT_PAGE_LIMIT;
    const rows = await this.userRepo.listBySite(this.prisma, { siteId, cursor, limit });
    return buildPage(rows, limit);
  }

  async deactivateAssignment(
    siteId: string,
    unitId: string,
    assignmentId: string,
    actor: AuthenticatedUser,
  ): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const row = await this.residentUnitAssignmentRepo.findScopedForUpdate(tx, {
        assignmentId,
        unitId,
        siteId,
      });
      if (!row) {
        throw new DomainError(
          ERROR_CODES.RESIDENT_UNIT_ASSIGNMENT_NOT_FOUND,
          HttpStatus.NOT_FOUND,
          'Ikamet ataması bulunamadi.',
        );
      }

      if (!row.isActive) {
        // Idempotent: zaten pasif, ikinci UPDATE/audit uretilmez.
        return;
      }

      await this.residentUnitAssignmentRepo.deactivate(tx, row.id);
      await this.audit.log(tx, {
        action: DOMAIN_AUDIT_ACTIONS.RESIDENT_UNIT_ASSIGNMENT_DEACTIVATED,
        actorUserId: actor.id,
        entityType: 'ResidentUnitAssignment',
        entityId: row.id,
        siteId,
        metadata: { unitId },
      });
    });
  }
}
