import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import { LoggerModule as PinoLoggerModule } from 'nestjs-pino';
import type { IncomingMessage } from 'node:http';

// Faz 9 Slice 4: pino-pretty bir devDependency'dir ve production runtime
// imajinda (npm prune --omit=dev) BULUNMAZ. CI runtime smoke'u imaji
// NODE_ENV=development ile boot ettigi icin pretty transport'u kosulsuz
// secmek boot'u "unable to determine transport target" ile dusuruyordu.
// Transport yalniz modul GERCEKTEN cozulebiliyorsa acilir; aksi halde plain
// JSON stdout logguna sessizce dusulur (imaja sonradan paket kurulmaz).
function isPinoPrettyAvailable(): boolean {
  try {
    require.resolve('pino-pretty');
    return true;
  } catch {
    return false;
  }
}

// Yapilandirilmis JSON log + request-id korelasyonu (docs planı Bolum 9).
// Request ID ayri bir interceptor/middleware yerine pino-http'nin genReqId
// secenegiyle uretilir: gelen x-request-id header'i varsa kullanilir, yoksa
// UUID uretilir; deger hem loglara hem GlobalExceptionFilter'a request.id
// uzerinden tasinir.
@Module({
  imports: [
    PinoLoggerModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const nodeEnv = config.get<string>('app.nodeEnv');
        const level = config.get<string>('logging.level') ?? 'info';
        const isProduction = nodeEnv === 'production';

        return {
          pinoHttp: {
            level,
            genReqId: (req: IncomingMessage) => {
              const headerValue = req.headers['x-request-id'];
              const existing = Array.isArray(headerValue) ? headerValue[0] : headerValue;
              return existing ?? randomUUID();
            },
            redact: {
              paths: [
                'req.headers.authorization',
                'req.headers.cookie',
                'req.body.otp',
                'req.body.code',
                'req.body.password',
                'req.body.refreshToken',
              ],
              censor: '[REDACTED]',
            },
            transport:
              isProduction || !isPinoPrettyAvailable()
                ? undefined
                : {
                    target: 'pino-pretty',
                    options: {
                      singleLine: true,
                      translateTime: 'SYS:standard',
                    },
                  },
          },
        };
      },
    }),
  ],
  exports: [PinoLoggerModule],
})
export class LoggerModule {}
