export interface TempMailConfig {
  apiKey: string;
  baseUrl: string;
}

export interface EmailAccount {
  email: string;
  quota: number;
  used: number;
  created_at: string;
  md5: string;
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
