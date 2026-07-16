import { Injectable } from '@nestjs/common';
import type { PrismaClientLike } from '../../../common/types/prisma-client-like.type';
import { normalizeE164 } from '../../../common/utils/phone.util';
import type { UserRole } from '../../../generated/prisma-client/enums';
import { PrismaService } from '../../../infrastructure/database/prisma/prisma.service';
import { UserRepository, type UserContactRow } from '../repositories/user.repository';

export interface RecipientContact {
  userId: string;
  phoneNumber: string;
}

// Faz 8 Dilim 1 (onaylanan docs/phase-8-plan.md Bolum 3.2/6.5): UsersModule
// disina acilan TEK bildirim-alicisi yuzeyi - ContractLookupService'in
// "repository asla export edilmez, dar isimlendirilmis servis export
// edilir" deseniyle ayni. Dondurulen her phoneNumber HER ZAMAN
// normalizeE164() cikisidir; cagiran taraf (NotificationDispatcher) ham DB
// degerine hicbir zaman erismez - dedup/unique kontrolu boylece daima
// normalize edilmis deger uzerinde calisir (plan Bolum 6.5).
@Injectable()
export class UserContactLookupService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly userRepo: UserRepository,
  ) {}

  async findActivePhoneById(
    userId: string,
    client: PrismaClientLike = this.prisma,
  ): Promise<RecipientContact | null> {
    const row = await this.userRepo.findActivePhoneById(client, userId);
    return row ? toContact(row) : null;
  }

  async findActivePhonesByIds(
    userIds: string[],
    client: PrismaClientLike = this.prisma,
  ): Promise<RecipientContact[]> {
    const rows = await this.userRepo.findActivePhonesByIds(client, userIds);
    return toContacts(rows);
  }

  async listActiveOperationsPhones(
    client: PrismaClientLike = this.prisma,
  ): Promise<RecipientContact[]> {
    const OPERATIONS: UserRole = 'OPERATIONS';
    const rows = await this.userRepo.listActiveByRole(client, OPERATIONS);
    return toContacts(rows);
  }
}

// DB'deki chk_users_phone_e164 CHECK constraint'i formati zaten garanti
// eder (bkz. docs/phase-8-plan.md Bolum 1) - normalizeE164() null donmesi
// yapisal olarak beklenmez, ama kontrol hic atlanmaz (plan Bolum 6.5:
// "kaynagin ortuk garantisine guvenmemeli"). Boyle bir kayit guvenle
// atlanir (telefonu olmayan/gecersiz alici SMS'e dahil edilmez).
function toContact(row: UserContactRow): RecipientContact | null {
  const phoneNumber = normalizeE164(row.phoneNumber);
  return phoneNumber ? { userId: row.id, phoneNumber } : null;
}

function toContacts(rows: UserContactRow[]): RecipientContact[] {
  const contacts: RecipientContact[] = [];
  for (const row of rows) {
    const contact = toContact(row);
    if (contact) contacts.push(contact);
  }
  return contacts;
}
