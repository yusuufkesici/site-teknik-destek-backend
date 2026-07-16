// OutboxRelay ve NotificationDeliveryRelay AYNI graceful-shutdown deseinini
// paylasir. `Promise.race([promise, timeout])` TEK BASINA yeterli DEGILDIR:
// kaybeden taraf (cogunlukla timeout) iptal edilmez - promise once
// cozulurse bile setTimeout araya girmis olarak calismaya devam eder ve
// dolana kadar Node event loop'unu (ve process'i) acik tutar. Bu yardimci
// HANGI taraf kazanirsa kazansin timer'i temizler.
export function raceWithTimeout(promise: Promise<void>, timeoutMs: number): Promise<void> {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, timeoutMs);
    promise.finally(() => {
      clearTimeout(timer);
      resolve();
    });
  });
}
