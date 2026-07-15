import { IsOptional, IsString, Matches, MaxLength } from 'class-validator';

// Onaylanan Faz 7 plani Bolum 4.3/14: currency bu DTO'da BILINCLI olarak
// YOKTUR - server, kilitli contract satirinin currency degerini snapshot
// olarak kopyalar; client fatura para birimini belirleyemez. Global
// ValidationPipe forbidNonWhitelisted=true oldugundan govdede currency
// gonderilirse 422 VALIDATION_ERROR doner. invoiceNumber ve status da
// client'tan alinmaz (sequence + her zaman DRAFT).
export class CreateInvoiceDto {
  @Matches(/^\d{4}-\d{2}-\d{2}$/, {
    message: 'billingPeriodStart YYYY-MM-DD formatinda olmalidir.',
  })
  billingPeriodStart!: string;

  @Matches(/^\d{4}-\d{2}-\d{2}$/, {
    message: 'billingPeriodEnd YYYY-MM-DD formatinda olmalidir.',
  })
  billingPeriodEnd!: string;

  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'issueDate YYYY-MM-DD formatinda olmalidir.' })
  issueDate!: string;

  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'dueDate YYYY-MM-DD formatinda olmalidir.' })
  dueDate!: string;

  @IsString()
  @Matches(/^\d{1,9}(\.\d{1,2})?$/, {
    message: 'amount en fazla 2 ondalikli pozitif sayi stringi olmalidir.',
  })
  amount!: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  note?: string;
}
