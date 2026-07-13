import { Prisma } from '../../generated/prisma-client/client';

// Facility/User/Membership servislerinin P2002 (unique constraint ihlali)
// hatasini domain-uygun 409'a cevirmesi icin paylasilan yardimci
// (onaylanan Faz 3 plani Bolum 8/9 - "kod hic DB'ye gitmeden ön-kontrol
// edilmez", P2002 servis katmaninda yakalanir).
export function isUniqueConstraintViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}
