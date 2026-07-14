import * as path from 'node:path';
import { generateStorageKey, resolveWithinBase } from './storage-key.util';

describe('generateStorageKey', () => {
  it('attachments/ altinda uuid tabanli bir key uretir', () => {
    const key = generateStorageKey();
    expect(key.startsWith('attachments/')).toBe(true);
    expect(key).not.toContain('..');
  });

  it('her cagrida farkli bir key uretir', () => {
    expect(generateStorageKey()).not.toBe(generateStorageKey());
  });
});

describe('resolveWithinBase', () => {
  const base = path.resolve('/var/uploads');

  it('base altindaki gecerli bir gorece yolu cozer', () => {
    const resolved = resolveWithinBase(base, 'attachments/abc-123');
    expect(resolved).toBe(path.join(base, 'attachments', 'abc-123'));
  });

  it('path traversal denemesini reddeder (../ ile base disina cikma)', () => {
    expect(() => resolveWithinBase(base, '../../etc/passwd')).toThrow();
  });

  it('base disindaki mutlak yol gibi davranan gorece yolu reddeder', () => {
    expect(() => resolveWithinBase(base, 'attachments/../../secrets')).toThrow();
  });
});
