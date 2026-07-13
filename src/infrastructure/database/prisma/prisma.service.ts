import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../../../generated/prisma-client/client';

// docs/implementation-overrides.md #1: baglanti @prisma/adapter-pg driver
// adapter uzerinden kurulur. Bu fazda soft-delete middleware/extension
// eklenmez (bkz. onaylanan Faz 1 plani Bolum 3) - ilk domain repository'si
// implemente edildiginde degerlendirilecektir.
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PrismaService.name);

  constructor(config: ConfigService) {
    const connectionString = config.getOrThrow<string>('database.url');
    super({ adapter: new PrismaPg({ connectionString }) });
  }

  async onModuleInit(): Promise<void> {
    await this.$queryRaw`SELECT 1`;
    this.logger.log('PostgreSQL baglantisi dogrulandi.');
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}
