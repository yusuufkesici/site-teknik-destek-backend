import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import {
  ASSIGNMENT_STATUS_EVENT_NAMES,
  type AssignmentStatusEventName,
} from '../state/assignment-status-event.map';

// Faz 5 Bolum 4: note yalniz event='COMPLETE' iken anlamlidir (yalniz
// resolutionNote kolonu var) - bu esleme DTO seviyesinde degil, servis
// katmaninda dogrulanir (diger DTO'larla tutarli konvansiyon).
export class UpdateAssignmentStatusDto {
  @IsIn(ASSIGNMENT_STATUS_EVENT_NAMES)
  event!: AssignmentStatusEventName;

  @IsOptional()
  @IsString()
  @MaxLength(4000)
  note?: string;
}
