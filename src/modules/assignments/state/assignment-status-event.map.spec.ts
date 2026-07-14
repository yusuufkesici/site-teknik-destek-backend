import { getAssignmentStatusEventRule } from './assignment-status-event.map';

describe('getAssignmentStatusEventRule', () => {
  it('EN_ROUTE: ACCEPTED -> ACTIVE, ticket EN_ROUTE, enRouteAt', () => {
    expect(getAssignmentStatusEventRule('EN_ROUTE')).toEqual({
      fromAssignmentStatus: 'ACCEPTED',
      toAssignmentStatus: 'ACTIVE',
      toTicketStatus: 'EN_ROUTE',
      timestampField: 'enRouteAt',
    });
  });

  it('ARRIVED: ACTIVE -> ACTIVE, ticket ARRIVED, arrivedAt', () => {
    expect(getAssignmentStatusEventRule('ARRIVED')).toEqual({
      fromAssignmentStatus: 'ACTIVE',
      toAssignmentStatus: 'ACTIVE',
      toTicketStatus: 'ARRIVED',
      timestampField: 'arrivedAt',
    });
  });

  it('START: ACTIVE -> ACTIVE, ticket IN_PROGRESS, startedAt', () => {
    expect(getAssignmentStatusEventRule('START')).toEqual({
      fromAssignmentStatus: 'ACTIVE',
      toAssignmentStatus: 'ACTIVE',
      toTicketStatus: 'IN_PROGRESS',
      timestampField: 'startedAt',
    });
  });

  it('WAIT_MATERIAL: ACTIVE -> ACTIVE, ticket WAITING_MATERIAL, timestampField yok', () => {
    expect(getAssignmentStatusEventRule('WAIT_MATERIAL')).toEqual({
      fromAssignmentStatus: 'ACTIVE',
      toAssignmentStatus: 'ACTIVE',
      toTicketStatus: 'WAITING_MATERIAL',
    });
  });

  it('RESUME: ACTIVE -> ACTIVE, ticket IN_PROGRESS, timestampField yok', () => {
    expect(getAssignmentStatusEventRule('RESUME')).toEqual({
      fromAssignmentStatus: 'ACTIVE',
      toAssignmentStatus: 'ACTIVE',
      toTicketStatus: 'IN_PROGRESS',
    });
  });

  it('COMPLETE: ACTIVE -> COMPLETED, ticket COMPLETED, completedAt', () => {
    expect(getAssignmentStatusEventRule('COMPLETE')).toEqual({
      fromAssignmentStatus: 'ACTIVE',
      toAssignmentStatus: 'COMPLETED',
      toTicketStatus: 'COMPLETED',
      timestampField: 'completedAt',
    });
  });
});
