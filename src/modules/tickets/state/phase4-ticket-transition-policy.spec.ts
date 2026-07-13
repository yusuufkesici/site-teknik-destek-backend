import { Phase4TicketTransitionPolicy } from './phase4-ticket-transition-policy';

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

describe('Phase4TicketTransitionPolicy', () => {
  const policy = new Phase4TicketTransitionPolicy();

  it.each([
    ['OPEN', 'TRIAGED'],
    ['OPEN', 'CANCELLED'],
    ['TRIAGED', 'CANCELLED'],
  ])('izin verilen gecis: %s -> %s', (from, to) => {
    expect(() => policy.assertAllowedInThisPhase(from as never, to as never)).not.toThrow();
  });

  it('TRIAGED -> ASSIGNED (state machine tanimli olsa da) Faz 4de koşulsuz reddedilir', () => {
    expectRejected(() => policy.assertAllowedInThisPhase('TRIAGED' as never, 'ASSIGNED' as never));
  });

  it('ASSIGNED -> CANCELLED, ticket veritabaninda ASSIGNED durumunda bulunsa bile reddedilir', () => {
    expectRejected(() =>
      policy.assertAllowedInThisPhase('ASSIGNED' as never, 'CANCELLED' as never),
    );
  });

  it('ASSIGNED -> ACCEPTED reddedilir (teknisyen akislari Faz 5)', () => {
    expectRejected(() => policy.assertAllowedInThisPhase('ASSIGNED' as never, 'ACCEPTED' as never));
  });

  it('rastgele diger ciftler de reddedilir', () => {
    expectRejected(() => policy.assertAllowedInThisPhase('COMPLETED' as never, 'CLOSED' as never));
    expectRejected(() =>
      policy.assertAllowedInThisPhase('IN_PROGRESS' as never, 'WAITING_MATERIAL' as never),
    );
  });
});
