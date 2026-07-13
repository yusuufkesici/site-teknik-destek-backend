import { execFileSync } from 'node:child_process';
import * as path from 'node:path';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';

export interface TestDatabase {
  container: StartedPostgreSqlContainer;
  databaseUrl: string;
}

const PROJECT_ROOT = path.resolve(__dirname, '..', '..', '..');

// Bu dosya AppModule/PrismaService/config dosyalarini IMPORT ETMEZ (dolayli
// erken yukleme riski tasimaz) - onaylanan Faz 2 plani Bolum 12, duzeltme #13.

// DATABASE_URL disindaki zorunlu env degiskenlerini test icin gecerli sabit
// degerlerle doldurur. Testcontainers/AppModule derlemesinden ONCE cagrilir.
export function configureBaseTestEnv(): void {
  process.env.NODE_ENV = 'test';
  process.env.PORT = '3000';
  process.env.JWT_ACCESS_SECRET = 'jwt-access-secret-'.padEnd(40, 'x');
  process.env.JWT_ACCESS_EXPIRES_IN = '900';
  process.env.REFRESH_TOKEN_PEPPER = 'refresh-token-pepper-'.padEnd(40, 'x');
  process.env.REFRESH_TOKEN_EXPIRES_IN = '2592000';
  process.env.OTP_HMAC_SECRET = 'otp-hmac-secret-'.padEnd(40, 'x');
  process.env.OTP_EXPIRES_IN_SECONDS = '180';
  process.env.OTP_MAX_ATTEMPTS = '5';
  process.env.OTP_RESEND_COOLDOWN_SECONDS = '60';
  process.env.SMS_PROVIDER = 'mock';
  process.env.STORAGE_PROVIDER = 'local';
  process.env.STORAGE_LOCAL_PATH = './var/uploads';
  process.env.CORS_ALLOWED_ORIGINS = 'http://localhost:5173';
  process.env.LOG_LEVEL = 'error';
  process.env.EMERGENCY_SLA_HOURS = '2';
}

// Zorunlu sira (duzeltme #13): container baslat -> dinamik URI al ->
// DATABASE_URL set et -> prisma migrate deploy -> DONUS. Cagiran test
// dosyasi AppModule'u ANCAK bu fonksiyon dondukten sonra dinamik import()
// ile yukler.
export async function startTestDatabase(): Promise<TestDatabase> {
  configureBaseTestEnv();

  const container = await new PostgreSqlContainer('postgres:16-alpine')
    .withDatabase('site_support_test')
    .withUsername('app')
    .withPassword('app')
    .start();

  const databaseUrl = container.getConnectionUri();
  process.env.DATABASE_URL = databaseUrl;

  const isWindows = process.platform === 'win32';
  const prismaBin = path.join(PROJECT_ROOT, 'node_modules', '.bin', isWindows ? 'prisma.cmd' : 'prisma');

  // Windows'ta .cmd dosyalari shell:true olmadan EINVAL verir; shell:true ise
  // args'i tirnaklamadan birlestirdigi icin Node deprecation uyarisi
  // dogurur. Sabit/statik argumanlarla (kullanici girdisi yok) cmd.exe /c
  // uzerinden dogrudan cagirmak ikisini de onler.
  if (isWindows) {
    execFileSync('cmd.exe', ['/c', prismaBin, 'migrate', 'deploy'], {
      cwd: PROJECT_ROOT,
      env: { ...process.env, DATABASE_URL: databaseUrl },
      stdio: 'inherit',
    });
  } else {
    execFileSync(prismaBin, ['migrate', 'deploy'], {
      cwd: PROJECT_ROOT,
      env: { ...process.env, DATABASE_URL: databaseUrl },
      stdio: 'inherit',
    });
  }

  return { container, databaseUrl };
}

export async function stopTestDatabase(testDb: TestDatabase): Promise<void> {
  await testDb.container.stop();
}
