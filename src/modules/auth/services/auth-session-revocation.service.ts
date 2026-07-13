import { Injectable } from '@nestjs/common';
import type { PrismaClientLike } from '../../../common/types/prisma-client-like.type';
import { RefreshSessionRepository } from '../repositories/refresh-session.repository';

// Dar port: UsersModule (global kullanici pasiflestirme) bu servisi
// kullanir, RefreshSessionRepository'ye DOGRUDAN erismez - modul,
// AuthModule sinirinin disina hic cikmaz (onaylanan Faz 3 plani Bolum 2/3,
// duzeltme #3).
@Injectable()
export class AuthSessionRevocationService {
  constructor(private readonly refreshSessionRepo: RefreshSessionRepository) {}

  async revokeAllForUser(client: PrismaClientLike, userId: string): Promise<void> {
    await this.refreshSessionRepo.revokeAllForUser(client, userId);
  }
}
