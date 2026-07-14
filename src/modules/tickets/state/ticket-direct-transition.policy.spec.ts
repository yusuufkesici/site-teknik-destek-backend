import { TicketDirectTransitionPolicy } from './ticket-direct-transition.policy';

function expectRejected(fn: () => void): void {
  let thrown: unknown;
  try {
    fn();
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeDefined();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const domainError = thrown as any;
  expect(domainError.code).toBe('TICKET_INVALID_STATUS_TRANSITION');
  expect(domainError.getStatus()).toBe(409);
}

describe('TicketDirectTransitionPolicy', () => {
  const policy = new TicketDirectTransitionPolicy();

  it.each([
    ['OPEN', 'TRIAGED'],
    ['OPEN', 'CANCELLED'],
    ['TRIAGED', 'CANCELLED'],
    ['COMPLETED', 'CLOSED'],
  ])('izin verilen gecis: %s -> %s', (from, to) => {
    expect(() => policy.assertAllowedDirectly(from as never, to as never)).not.toThrow();
  });

  it('COMPLETED -> IN_PROGRESS (reopen) bu fazda desteklenmedigi icin reddedilir', () => {
    expectRejected(() =>
      policy.assertAllowedDirectly('COMPLETED' as never, 'IN_PROGRESS' as never),
    );
  });

  it('ASSIGNED -> CANCELLED genel uctan reddedilir (yalniz workflow service yapabilir)', () => {
    expectRejected(() => policy.assertAllowedDirectly('ASSIGNED' as never, 'CANCELLED' as never));
  });

  it('TRIAGED -> ASSIGNED genel uctan reddedilir (assignment akisina ait)', () => {
    expectRejected(() => policy.assertAllowedDirectly('TRIAGED' as never, 'ASSIGNED' as never));
  });

  it('ASSIGNED -> ACCEPTED genel uctan reddedilir (teknisyen akisina ait)', () => {
    expectRejected(() => policy.assertAllowedDirectly('ASSIGNED' as never, 'ACCEPTED' as never));
  });

  it('rastgele diger ciftler de reddedilir', () => {
    expectRejected(() =>
      policy.assertAllowedDirectly('IN_PROGRESS' as never, 'WAITING_MATERIAL' as never),
    );
  });
});
