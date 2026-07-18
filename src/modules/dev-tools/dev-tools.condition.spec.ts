import { isDevToolsEnabled } from './dev-tools.condition';

// Faz 9 karar #2: route mount kosulunun kaniti. Production tam boot
// edilemedigi icin (gercek SMS provider yok) production dislamasi bu saf
// fonksiyon uzerinden dogrulanir; app.module.ts ayni fonksiyonu kullanir.
describe('isDevToolsEnabled', () => {
  it('development + DEV_SMS_INBOX_ENABLED=true: acik', () => {
    expect(isDevToolsEnabled({ NODE_ENV: 'development', DEV_SMS_INBOX_ENABLED: 'true' })).toBe(
      true,
    );
  });

  it('development + DEV_SMS_INBOX_ENABLED=false veya verilmemis: kapali', () => {
    expect(isDevToolsEnabled({ NODE_ENV: 'development', DEV_SMS_INBOX_ENABLED: 'false' })).toBe(
      false,
    );
    expect(isDevToolsEnabled({ NODE_ENV: 'development' })).toBe(false);
  });

  it('production: DEV_SMS_INBOX_ENABLED=true olsa bile kapali', () => {
    expect(isDevToolsEnabled({ NODE_ENV: 'production', DEV_SMS_INBOX_ENABLED: 'true' })).toBe(
      false,
    );
  });

  it('test: DEV_SMS_INBOX_ENABLED=true olsa bile kapali', () => {
    expect(isDevToolsEnabled({ NODE_ENV: 'test', DEV_SMS_INBOX_ENABLED: 'true' })).toBe(false);
  });

  it('NODE_ENV tanimsiz: kapali', () => {
    expect(isDevToolsEnabled({ DEV_SMS_INBOX_ENABLED: 'true' })).toBe(false);
  });
});
