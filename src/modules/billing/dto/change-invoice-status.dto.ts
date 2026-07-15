import { IsEnum, IsOptional, IsString, Matches, MaxLength } from 'class-validator';
import { InvoiceStatus, PaymentMethod } from '../../../generated/prisma-client/enums';

// Onaylanan Faz 7 plani Bolum 4.5: paymentMethod/referenceNumber YALNIZ hedef
// status PAID iken kabul edilir; baska hedeflerle gonderilirse servis 422
// VALIDATION_ERROR doner. PAID hedefinde paymentMethod eksikligi DTO degil
// SERVIS katmaninda 422 INVOICE_PAYMENT_DETAILS_REQUIRED uretir (domain
// kurali, sekil kurali degil). paidAt hicbir kosulda client'tan alinmaz
// (DTO'da yoktur; forbidNonWhitelisted=true gonderilirse 422 uretir).
export class ChangeInvoiceStatusDto {
  @IsEnum(InvoiceStatus)
  status!: InvoiceStatus;

  @IsOptional()
  @IsEnum(PaymentMethod)
  paymentMethod?: PaymentMethod;

  // BANK_TRANSFER icin zorunlulugu (trim-bos olamaz) servis katmani dogrular
  // (INVOICE_PAYMENT_DETAILS_REQUIRED); DTO yalniz sekil dogrular.
  @IsOptional()
  @IsString()
  @Matches(/\S/, { message: 'referenceNumber bos olamaz.' })
  @MaxLength(100)
  referenceNumber?: string;
}
