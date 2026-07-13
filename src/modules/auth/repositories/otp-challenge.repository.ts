import { Injectable } from '@nestjs/common';
import type { PrismaClientLike } from '../../../common/types/prisma-client-like.type';
import type { OtpPurpose } from '../../../generated/prisma-client/enums';

export interface OtpChallengeForUpdate {
  id: string;
  userId: string | null;
  phoneNumber: string;
  purpose: OtpPurpose;
  codeHash: string;
  expiresAt: Date;
  consumedAt: Date | null;
  invalidatedAt: Date | null;
  attemptCount: number;
  maxAttempts: number;
  requestedIp: string;
  userAgent: string | null;
  createdAt: Date;
}

export interface CreateOtpChallengeInput {
  userId: string;
  phoneNumber: string;
  purpose: OtpPurpose;
  codeHash: string;
  expiresAt: Date;
  maxAttempts: number;
  requestedIp: string;
  userAgent?: string;
}

@Injectable()
export class OtpChallengeRepository {
  // Ayni telefon icin acik (tuketilmemis/invalidate edilmemis) onceki
  // challenge'lari yeni istekte gecersiz kilar (onaylanan Faz 2 plani
  // Bolum 6, adim 7).
  async invalidateOpen(client: PrismaClientLike, phoneNumber: string): Promise<void> {
    await client.otpChallenge.updateMany({
      where: {
        phoneNumber,
        purpose: 'LOGIN',
        consumedAt: null,
        invalidatedAt: null,
      },
      data: { invalidatedAt: new Date() },
    });
  }

  async create(client: PrismaClientLike, input: CreateOtpChallengeInput): Promise<void> {
    await client.otpChallenge.create({
      data: {
        userId: input.userId,
        phoneNumber: input.phoneNumber,
        purpose: input.purpose,
        codeHash: input.codeHash,
        expiresAt: input.expiresAt,
        maxAttempts: input.maxAttempts,
        requestedIp: input.requestedIp,
        userAgent: input.userAgent,
      },
    });
  }

  // FOR UPDATE ile satir kilidi: ayni OTP'nin cift dogrulanmasini engeller
  // (onaylanan Faz 2 plani Bolum 7, adim 2a).
  async findActiveForUpdate(
    client: PrismaClientLike,
    phoneNumber: string,
  ): Promise<OtpChallengeForUpdate | null> {
    const rows = await client.$queryRaw<OtpChallengeForUpdate[]>`
      SELECT
        id,
        user_id AS "userId",
        phone_number AS "phoneNumber",
        purpose,
        code_hash AS "codeHash",
        expires_at AS "expiresAt",
        consumed_at AS "consumedAt",
        invalidated_at AS "invalidatedAt",
        attempt_count AS "attemptCount",
        max_attempts AS "maxAttempts",
        requested_ip AS "requestedIp",
        user_agent AS "userAgent",
        created_at AS "createdAt"
      FROM otp_challenges
      WHERE phone_number = ${phoneNumber}
        AND purpose = 'LOGIN'
        AND consumed_at IS NULL
        AND invalidated_at IS NULL
        AND expires_at > now()
      ORDER BY created_at DESC
      LIMIT 1
      FOR UPDATE
    `;

    return rows[0] ?? null;
  }

  // Savunmaci, artissiz invalidate (onaylanan Faz 2 plani Bolum 7, adim 2c —
  // duzeltme #11): hash karsilastirmasindan once calisan ikinci savunma hatti.
  async invalidate(client: PrismaClientLike, challengeId: string): Promise<void> {
    await client.otpChallenge.update({
      where: { id: challengeId },
      data: { invalidatedAt: new Date() },
    });
  }

  // Tek atomik UPDATE: attemptCount artar VE esikte ayni anda invalidate
  // edilir (onaylanan Faz 2 plani Bolum 7, adim 2d — duzeltme #2).
  async incrementAttemptAndMaybeInvalidate(
    client: PrismaClientLike,
    challengeId: string,
    maxAttempts: number,
  ): Promise<{ attemptCount: number; invalidated: boolean }> {
    const rows = await client.$queryRaw<{ attemptCount: number; invalidated: boolean }[]>`
      UPDATE otp_challenges
      SET attempt_count = attempt_count + 1,
          invalidated_at = CASE
            WHEN attempt_count + 1 >= ${maxAttempts} THEN now()
            ELSE invalidated_at
          END
      WHERE id = ${challengeId}
      RETURNING attempt_count AS "attemptCount", (invalidated_at IS NOT NULL) AS "invalidated"
    `;

    const row = rows[0];
    if (!row) {
      throw new Error(`OTP challenge bulunamadi: ${challengeId}`);
    }

    return row;
  }

  async consume(client: PrismaClientLike, challengeId: string): Promise<void> {
    await client.otpChallenge.update({
      where: { id: challengeId },
      data: { consumedAt: new Date() },
    });
  }
}
