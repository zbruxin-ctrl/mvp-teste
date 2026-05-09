import fetch from 'node-fetch';
import { globalState } from '../state/globalState';
import {
  EmailAccount,
  MailMessage,
  TempMailConfig,
} from '../types/tempMail';
import { OTPParser } from '../utils/otpParser';

// API temp-mail.io (v1)
// POST https://api.tempmail.lol/v1/email          -> cria inbox, retorna emailaccount { email, md5 }
// GET  https://api.tempmail.lol/v1/messages/<md5> -> lista mensagens
// Auth: header X-API-Key

export class TempMailClient {
  private config: TempMailConfig;

  constructor(apiKey: string) {
    this.config = {
      apiKey,
      baseUrl: 'https://api.tempmail.lol/v1',
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
    // POST /email -> { success, emailaccount: { email, md5, quota, used, created_at } }
    const data = await this.request<{ success: boolean; emailaccount: EmailAccount }>(
      '/email',
      'POST'
    );
    return data.emailaccount;
  }

  async listMessages(emailMd5: string): Promise<MailMessage[]> {
    // GET /messages/<md5> -> { success, messages: MailMessage[] }
    const data = await this.request<{ success: boolean; messages: MailMessage[] }>(
      `/messages/${emailMd5}`
    );
    return data.messages ?? [];
  }

  async getAvailableDomains(): Promise<string[]> {
    const data = await this.request<{ success: boolean; domain: string }>('/domains');
    return data.domain ? [data.domain] : [];
  }

  async waitForOTP(emailMd5: string, timeoutMs = 30000): Promise<string> {
    const startTime = Date.now();
    let lastMessageCount = 0;

    globalState.addLog('info', `⏳ Aguardando OTP (${Math.round(timeoutMs / 1000)}s)...`);

    while (Date.now() - startTime < timeoutMs) {
      if ((globalState.getState() as { shouldStop?: boolean }).shouldStop) {
        throw new Error('Parado pelo usuário durante espera do OTP');
      }

      try {
        const messages = await this.listMessages(emailMd5);

        if (messages.length > lastMessageCount) {
          globalState.addLog('info', `📨 ${messages.length} mensagem(s) recebida(s)`);

          for (const message of messages.slice().reverse()) {
            const otp = OTPParser.extractFromMessage(message);
            if (otp) {
              globalState.addLog('success', `🎉 OTP encontrado: ${otp}`);
              return otp;
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
    const otp = await this.waitForOTP(emailAccount.md5, timeoutMs);
    return { email: emailAccount.email, md5: emailAccount.md5, otp };
  }
}
