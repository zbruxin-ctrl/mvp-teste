export interface TempMailConfig {
  apiKey: string;
  baseUrl: string;
}

// Resposta real do endpoint GET /generate/v2 da Temp-Mail LOL
export interface EmailAccount {
  email: string;
  token: string;  // usado para checar inbox (era 'md5' na versão antiga)
}

export interface MailMessage {
  mail_id: string;
  mail_from: string;
  mail_to: string;
  mail_subject: string;
  mail_preview: string;
  mail_html: string;
  mail_text: string;
  created_at: string;
  attachments?: unknown[];
}

export interface TempMailError {
  code: number;
  message: string;
}
