import { defineConfig, env } from 'prisma/config';

// Prisma CLI (migrate/introspect) icin baglanti URL'si burada tanimlanir;
// docs/implementation-overrides.md #1: baglanti bilgisi schema.prisma
// icinde degil, prisma.config.ts icinde tutulur.
// Not: @prisma/config'in "datasource" alani yalniz url/shadowDatabaseUrl
// dizesi kabul eder (driver adapter degil) - CLI migration/introspect
// komutlari icin kullanilir. Uygulama calisma zamaninda PrismaService,
// @prisma/adapter-pg driver adapter'ini ayrica kendi icinde kurar
// (src/infrastructure/database/prisma/prisma.service.ts).
export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
  },
  datasource: {
    url: env('DATABASE_URL'),
  },
});
