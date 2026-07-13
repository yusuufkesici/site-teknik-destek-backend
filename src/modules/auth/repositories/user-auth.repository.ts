import { Injectable } from '@nestjs/common';
import type { PrismaClientLike } from '../../../common/types/prisma-client-like.type';
import type { UserRole } from '../../../generated/prisma-client/enums';

export interface AuthUser {
  id: string;
  role: UserRole;
  isActive: boolean;
  tokenVersion: number;
  firstName: string;
  lastName: string;
}

const AUTH_USER_SELECT = {
  id: true,
  role: true,
  isActive: true,
  tokenVersion: true,
  firstName: true,
  lastName: true,
} as const;

// Faz 3'te tam UsersService/UsersModule gelene kadar yalnizca auth'un
// ihtiyac duydugu salt-okunur sorgular (onaylanan Faz 2 plani Bolum 5).
@Injectable()
export class UserAuthRepository {
  async findActiveByPhone(client: PrismaClientLike, phone: string): Promise<AuthUser | null> {
    return client.user.findFirst({
      where: { phoneNumber: phone, isActive: true, deletedAt: null },
      select: AUTH_USER_SELECT,
    });
  }

  async findActiveById(client: PrismaClientLike, id: string): Promise<AuthUser | null> {
    return client.user.findFirst({
      where: { id, isActive: true, deletedAt: null },
      select: AUTH_USER_SELECT,
    });
  }

  async touchLastLogin(client: PrismaClientLike, id: string): Promise<void> {
    await client.user.update({
      where: { id },
      data: { lastLoginAt: new Date() },
    });
  }
}
