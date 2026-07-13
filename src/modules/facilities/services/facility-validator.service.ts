import { HttpStatus, Injectable } from '@nestjs/common';
import { ERROR_CODES } from '../../../common/constants/error-codes.constant';
import { DomainError } from '../../../common/errors/domain-error';
import type { FacilityType } from '../../../generated/prisma-client/enums';
import type { FacilityRow } from '../repositories/facility.repository';

const VALID_PARENT_TYPES: Record<Exclude<FacilityType, 'SITE'>, FacilityType[]> = {
  BLOCK: ['SITE'],
  UNIT: ['BLOCK'],
  COMMON_AREA: ['SITE', 'BLOCK'],
};

// Onaylanan Faz 3 plani Bolum 8: hiyerarsi kurallari + siteId turetimi.
// SITE'in parent'i yok (bu servis SITE olusturmada cagirilmaz). BLOCK yalniz
// SITE altinda, UNIT yalniz BLOCK altinda, COMMON_AREA SITE veya BLOCK
// altinda olusturulabilir. siteId her zaman kilitli parent satirindan
// turetilir (client girdisine guvenilmez).
@Injectable()
export class FacilityValidatorService {
  assertValidParentAndDeriveSiteId(
    childType: Exclude<FacilityType, 'SITE'>,
    parent: FacilityRow | null,
  ): string {
    if (!parent) {
      throw new DomainError(
        ERROR_CODES.FACILITY_NOT_FOUND,
        HttpStatus.NOT_FOUND,
        'Ust facility bulunamadi.',
      );
    }

    const allowedParentTypes = VALID_PARENT_TYPES[childType];
    if (!allowedParentTypes.includes(parent.type)) {
      throw new DomainError(
        ERROR_CODES.FACILITY_INVALID_PARENT,
        HttpStatus.UNPROCESSABLE_ENTITY,
        `${childType} tipi icin gecersiz ust facility tipi: ${parent.type}.`,
      );
    }

    const siteId = parent.type === 'SITE' ? parent.id : parent.siteId;
    if (!siteId) {
      throw new DomainError(
        ERROR_CODES.FACILITY_INVALID_PARENT,
        HttpStatus.UNPROCESSABLE_ENTITY,
        'Ust facility icin siteId turetilemedi.',
      );
    }

    return siteId;
  }
}
