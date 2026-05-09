import fetch from 'node-fetch';
import { globalState } from '../state/globalState';
import {
  EmailAccount,
  MailMessage,
  TempMailConfig,
} from '../types/tempMail';
import { OTPParser } from '../utils/otpParser';

// API temp-mail.io — documentacao: https://docs.temp-mail.io/docs/getting-started
// Base URL : https://api.temp-mail.io
// POST /v1/emails                          -> cria inbox, retorna { email, ttl }
// GET  /v1/emails/{email}/messages         -> lista mensagens
// GET  /v1/messages/{id}                   -> busca mensagem completa (body_text, body_html)
// Auth: header X-API-Key

export class TempMailClient {
  private config: TempMailConfig;

  constructor(apiKey: string) {
    this.config = {
      apiKey,
      baseUrl: 'https://api.temp-mail.io',
    };
  }

  private async request<T>(
    endpoint: string,
    method: 'GET' | 'POST' = 'GET'
  ): Promise<T> {
    const url = `${this.config.baseUrl}${endpoint}`;
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'X-API-Key': this.config.apiKey,
    };

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 15000);

    try {
      globalState.addLog('info', `📧 Temp-Mail: ${method} ${endpoint}`);

      const response = await fetch(url, {
        method,
        headers,
        signal: controller.signal as AbortSignal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        const text = await response.text().catch(() => response.statusText);
        throw new Error(`Temp-Mail ${response.status}: ${text}`);
      }

      const data = await response.json() as T;
      globalState.addLog('success', `✅ Temp-Mail OK: ${endpoint}`);
      return data;
    } catch (error) {
      clearTimeout(timeoutId);
      const message = error instanceof Error ? error.message : 'Erro desconhecido';
      globalState.addLog('error', `❌ Temp-Mail ${endpoint}: ${message}`);
      throw error;
    }
  }

  async createRandomEmail(): Promise<EmailAccount> {
    // POST /v1/emails -> { email: string, ttl: number }
    const data = await this.request<{ email: string; ttl: number }>(
      '/v1/emails',
      'POST'
    );
    // Adapta para o formato EmailAccount esperado pelo resto do codigo
    return {
      email: data.email,
      md5: data.email, // usamos o proprio email como identificador
      quota: 0,
      used: 0,
      created_at: new Date().toISOString(),
    } as unknown as EmailAccount;
  }

  async listMessages(email: string): Promise<MailMessage[]> {
    // GET /v1/emails/{email}/messages -> { messages: [...] }
    const data = await this.request<{ messages: Array<{
      id: string;
      from: string;
      subject: string;
      created_at: string;
    }> }>(`/v1/emails/${encodeURIComponent(email)}/messages`);
    return (data.messages ?? []).map(m => ({
      mail_id: m.id,
      mail_from: m.from,
      mail_to: email,
      mail_subject: m.subject,
      mail_preview: '',
      mail_html: '',
      mail_text: '',
      created_at: m.created_at,
    })) as unknown as MailMessage[];
  }

  async getFullMessage(messageId: string): Promise<{ body_text: string; body_html: string }> {
    // GET /v1/messages/{id} -> mensagem completa com body_text e body_html
    return this.request<{ body_text: string; body_html: string }>(`/v1/messages/${messageId}`);
  }

  async getAvailableDomains(): Promise<string[]> {
    const data = await this.request<{ domains: string[] }>('/v1/domains');
    return data.domains ?? [];
  }

  async waitForOTP(email: string, timeoutMs = 30000): Promise<string> {
    const startTime = Date.now();
    let lastMessageCount = 0;

    globalState.addLog('info', `⏳ Aguardando OTP (${Math.round(timeoutMs / 1000)}s)...`);

    while (Date.now() - startTime < timeoutMs) {
      if ((globalState.getState() as { shouldStop?: boolean }).shouldStop) {
        throw new Error('Parado pelo usuário durante espera do OTP');
      }

      try {
        const messages = await this.listMessages(email);

        if (messages.length > lastMessageCount) {
          globalState.addLog('info', `📨 ${messages.length} mensagem(s) recebida(s)`);

          // Busca o body completo de cada nova mensagem para extrair OTP
          for (const message of messages.slice(lastMessageCount).reverse()) {
            const msgId = (message as unknown as { mail_id: string }).mail_id;
            try {
              const full = await this.getFullMessage(msgId);
              const msgWithBody = {
                ...message,
                mail_text: full.body_text ?? '',
                mail_html: full.body_html ?? '',
              };
              const otp = OTPParser.extractFromMessage(msgWithBody as unknown as MailMessage);
              if (otp) {
                globalState.addLog('success', `🎉 OTP encontrado: ${otp}`);
                return otp;
              }
            } catch {
              // ignora erro ao buscar corpo individual, tenta proxima
            }
          }
        }

        lastMessageCount = messages.length;
      } catch (e) {
        if (e instanceof Error && e.message.includes('Parado')) throw e;
        globalState.addLog('warn', '⚠️ Erro ao verificar mensagens, tentando novamente...');
      }

      await new Promise<void>((r) => setTimeout(r, 3000));
    }

    throw new Error(`⏰ Timeout aguardando OTP (${Math.round(timeoutMs / 1000)}s)`);
  }

  async createEmailAndWaitOTP(
    timeoutMs = 30000
  ): Promise<{ email: string; md5: string; otp: string }> {
    const emailAccount = await this.createRandomEmail();
    globalState.addLog('info', `📧 Email criado: ${emailAccount.email}`);
    const otp = await this.waitForOTP(emailAccount.email, timeoutMs);
    return { email: emailAccount.email, md5: emailAccount.email, otp };
  }
}
