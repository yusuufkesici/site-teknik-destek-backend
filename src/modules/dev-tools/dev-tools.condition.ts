// Faz 9 karar #2: DevToolsModule'un mount kosulu. Modul kompozisyonu import
// zamaninda gerceklestigi icin bu kosul ConfigService'ten ONCE, ham env
// uzerinden degerlendirilir (app.module.ts). Ayni cift kosul calisma
// zamaninda devSmsInboxConfig.enabled (configuration.ts) ve controller
// tarafindan yeniden dogrulanir. Saf fonksiyon olmasi production/test
// kompozisyonunun izole unit testle kanitlanmasini saglar
// (dev-tools.condition.spec.ts).
export function isDevToolsEnabled(env: {
  NODE_ENV?: string;
  DEV_SMS_INBOX_ENABLED?: string;
}): boolean {
  return env.NODE_ENV === 'development' && env.DEV_SMS_INBOX_ENABLED === 'true';
}
