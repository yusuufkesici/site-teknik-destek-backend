// Faz 9 Slice 4: Express varsayilanina ortuk guven yerine JSON/urlencoded
// body limiti tek yerde, acikca tanimlanir (main.ts ve HTTP body-limit
// e2e testi ayni sabiti kullanir). Attachment yuklemeleri multipart oldugu
// icin bu limitten ETKILENMEZ - dosya boyutu siniri ayridir
// (MAX_FILE_SIZE_BYTES, attachment.constant.ts / Multer FileInterceptor).
export const HTTP_BODY_LIMIT = '100kb';
