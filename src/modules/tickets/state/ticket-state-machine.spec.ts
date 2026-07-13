import { TicketStateMachine } from './ticket-state-machine';

const VALID_TRANSITIONS: Array<{ from: string; to: string; role: string; reason?: string }> = [
  { from: 'OPEN', to: 'TRIAGED', role: 'OPERATIONS' },
  { from: 'OPEN', to: 'CANCELLED', role: 'RESIDENT', reason: 'vazgectim' },
  { from: 'OPEN', to: 'CANCELLED', role: 'SITE_MANAGER', reason: 'vazgectim' },
  { from: 'OPEN', to: 'CANCELLED', role: 'OPERATIONS', reason: 'vazgectim' },
  { from: 'TRIAGED', to: 'ASSIGNED', role: 'OPERATIONS' },
  { from: 'TRIAGED', to: 'CANCELLED', role: 'SITE_MANAGER', reason: 'vazgectim' },
  { from: 'TRIAGED', to: 'CANCELLED', role: 'OPERATIONS', reason: 'vazgectim' },
  { from: 'ASSIGNED', to: 'ACCEPTED', role: 'TECHNICIAN' },
  { from: 'ASSIGNED', to: 'REJECTED', role: 'TECHNICIAN', reason: 'musait degilim' },
  { from: 'ASSIGNED', to: 'CANCELLED', role: 'OPERATIONS', reason: 'iptal' },
  { from: 'REJECTED', to: 'ASSIGNED', role: 'OPERATIONS' },
  { from: 'ACCEPTED', to: 'EN_ROUTE', role: 'TECHNICIAN' },
  { from: 'EN_ROUTE', to: 'ARRIVED', role: 'TECHNICIAN' },
  { from: 'ARRIVED', to: 'IN_PROGRESS', role: 'TECHNICIAN' },
  { from: 'IN_PROGRESS', to: 'WAITING_MATERIAL', role: 'TECHNICIAN' },
  { from: 'IN_PROGRESS', to: 'COMPLETED', role: 'TECHNICIAN' },
  { from: 'WAITING_MATERIAL', to: 'IN_PROGRESS', role: 'TECHNICIAN' },
  { from: 'COMPLETED', to: 'CLOSED', role: 'OPERATIONS' },
  { from: 'COMPLETED', to: 'IN_PROGRESS', role: 'OPERATIONS', reason: 'yeniden acildi' },
];

function expectDomainError(fn: () => void, code: string, status: number): void {
  let thrown: unknown;
  try {
    fn();
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeDefined();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const domainError = thrown as any;
  expect(domainError.code).toBe(code);
  expect(domainError.getStatus()).toBe(status);
}

describe('TicketStateMachine', () => {
  const machine = new TicketStateMachine();

  it.each(VALID_TRANSITIONS)(
    'gecerli gecis: $from -> $to ($role)',
    ({ from, to, role, reason }) => {
      expect(() =>
        machine.assertTransition(from as never, to as never, role as never, reason),
      ).not.toThrow();
    },
  );

  it('from===to icin TICKET_STATUS_UNCHANGED (409) firlatir', () => {
    expectDomainError(
      () => machine.assertTransition('OPEN' as never, 'OPEN' as never, 'OPERATIONS' as never),
      'TICKET_STATUS_UNCHANGED',
      409,
    );
  });

  it('tanimsiz gecis icin TICKET_INVALID_STATUS_TRANSITION (409) firlatir', () => {
    expectDomainError(
      () => machine.assertTransition('OPEN' as never, 'ACCEPTED' as never, 'OPERATIONS' as never),
      'TICKET_INVALID_STATUS_TRANSITION',
      409,
    );
  });

  it('CLOSED ve CANCELLED terminal durumlardir - hicbir gecise izin vermez', () => {
    expectDomainError(
      () => machine.assertTransition('CLOSED' as never, 'OPEN' as never, 'OPERATIONS' as never),
      'TICKET_INVALID_STATUS_TRANSITION',
      409,
    );
    expectDomainError(
      () => machine.assertTransition('CANCELLED' as never, 'OPEN' as never, 'OPERATIONS' as never),
      'TICKET_INVALID_STATUS_TRANSITION',
      409,
    );
  });

  it('gecerli gecis ama yanlis rol icin TICKET_TRANSITION_FORBIDDEN (403) firlatir', () => {
    expectDomainError(
      () => machine.assertTransition('OPEN' as never, 'TRIAGED' as never, 'RESIDENT' as never),
      'TICKET_TRANSITION_FORBIDDEN',
      403,
    );
  });

  it('reason zorunlu gecislerde reason eksikse TICKET_TRANSITION_REASON_REQUIRED (422) firlatir', () => {
    expectDomainError(
      () => machine.assertTransition('OPEN' as never, 'CANCELLED' as never, 'RESIDENT' as never),
      'TICKET_TRANSITION_REASON_REQUIRED',
      422,
    );
    expectDomainError(
      () =>
        machine.assertTransition('OPEN' as never, 'CANCELLED' as never, 'RESIDENT' as never, '   '),
      'TICKET_TRANSITION_REASON_REQUIRED',
      422,
    );
  });
});
