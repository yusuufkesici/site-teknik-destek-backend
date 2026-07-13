import type { Prisma } from '../../generated/prisma-client/client';
import type { PrismaService } from '../../infrastructure/database/prisma/prisma.service';

// Repository/writer metotlarinin hem transaction disinda (kok PrismaService)
// hem transaction icinden (Prisma.TransactionClient) cagrilabilmesi icin
// ortak tip (onaylanan Faz 2 plani Bolum 5, duzeltme #3).
export type PrismaClientLike = PrismaService | Prisma.TransactionClient;
