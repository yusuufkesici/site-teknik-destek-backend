import { Controller, Get, HttpCode, HttpStatus, ServiceUnavailableException } from '@nestjs/common';
import { Public } from '../../common/decorators/public.decorator';
import { PrismaService } from '../../infrastructure/database/prisma/prisma.service';

interface LivenessResponse {
  status: 'ok';
}

interface ReadinessResponse {
  status: 'ok';
  database: 'ok';
}

// docs/architecture.md Bolum 11 (Health): liveness sureci, readiness DB
// baglantisini kontrol eder. SMS provider durumu bu fazda raporlanmaz
// (SmsProvider henuz implemente edilmedi - onaylanan Faz 1 plani Bolum 8/12).
@Controller('health')
export class HealthController {
  constructor(private readonly prisma: PrismaService) {}

  @Public()
  @Get('liveness')
  @HttpCode(HttpStatus.OK)
  liveness(): LivenessResponse {
    return { status: 'ok' };
  }

  @Public()
  @Get('readiness')
  @HttpCode(HttpStatus.OK)
  async readiness(): Promise<ReadinessResponse> {
    try {
      await this.prisma.$queryRaw`SELECT 1`;
    } catch {
      throw new ServiceUnavailableException('Veritabani baglantisi kurulamadi.');
    }

    return { status: 'ok', database: 'ok' };
  }
}
