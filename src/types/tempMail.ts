export interface TempMailConfig {
  apiKey: string;
  baseUrl: string;
}

export interface TempMailError {
  code: number;
  message: string;
}

export interface CreateDomainResponse {
  success: boolean;
  action_status: string;
  domain: string;
}

export interface EmailAccount {
  email: string;
  quota: number;
  used: number;
  created_at: string;
  md5: string;
}

export interface CreateEmailResponse {
  success: boolean;
  action_status: string;
  emailaccount: EmailAccount;
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
  attachments?: any[];
}

export interface ListMessagesResponse {
  success: boolean;
  action_status: string;
  messages: MailMessage[];
}

export interface GetMessageResponse {
  success: boolean;
  action_status: string;
  message: MailMessage;
}