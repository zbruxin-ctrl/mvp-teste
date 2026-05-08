import fetch from 'node-fetch';
import { globalState } from '../state/globalState';
import {
  EmailAccount,
  MailMessage,
  TempMailConfig,
} from '../types/tempMail';
import { OTPParser } from '../utils/otpParser';

export class TempMailClient {
  private config: TempMailConfig;

  constructor(apiKey: string) {
    this.config = {
      apiKey,
      baseUrl: 'https://api.tempmail.lol/v1',
    };
  }

  private async request<T>(endpoint: string, options: Record<string, unknown> = {}): Promise<T> {
    const url = `${this.config.baseUrl}${endpoint}`;
    const headers: Record<string, string> = {
      'X-API-Key': this.config.apiKey,
      'Content-Type': 'application/json',
      ...((options.headers as Record<string, string>) || {}),
    };

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10000);

    try {
      globalState.addLog('info', `📧 Temp-Mail: ${endpoint}`);

      const response = await fetch(url, {
        method: (options.method as string) || 'GET',
        headers,
        body: options.body as string | undefined,
        signal: controller.signal as AbortSignal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({})) as Record<string, unknown>;
        throw new Error(
          `Temp-Mail ${response.status}: ${(errorData.message as string) || response.statusText}`
        );
      }

      const data = await response.json() as T & { success?: boolean; action_status?: string };

      if (data.success === false) {
        throw new Error(`Temp-Mail falhou: ${data.action_status || 'Erro desconhecido'}`);
      }

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
    const data = await this.request<{ success: boolean; emailaccount: EmailAccount }>('/email');
    return data.emailaccount;
  }

  async listMessages(emailMd5: string): Promise<MailMessage[]> {
    const data = await this.request<{ success: boolean; messages: MailMessage[] }>(`/messages/${emailMd5}`);
    return data.messages || [];
  }

  async getMessage(emailMd5: string, messageId: string): Promise<MailMessage> {
    const data = await this.request<{ success: boolean; message: MailMessage }>(`/messages/${emailMd5}/${messageId}`);
    return data.message;
  }

  async getAvailableDomains(): Promise<string[]> {
    const data = await this.request<{ success: boolean; domain: string }>('/domains');
    return [data.domain];
  }

  async waitForOTP(emailMd5: string, timeoutMs = 30000): Promise<string> {
    const startTime = Date.now();
    let lastMessageCount = 0;

    globalState.addLog('info', `⏳ Aguardando OTP (${Math.round(timeoutMs / 1000)}s)...`);

    while (Date.now() - startTime < timeoutMs) {
      try {
        const messages = await this.listMessages(emailMd5);

        if (messages.length > lastMessageCount) {
          globalState.addLog('info', `📨 ${messages.length} mensagem(s) recebida(s)`);

          for (const message of messages.slice().reverse()) {
            const otp = OTPParser.extractFromMessage(message);
            if (otp) {
              globalState.addLog('success', `🎉 OTP: ${otp}`);
              return otp;
            }
          }
        }

        lastMessageCount = messages.length;
      } catch {
        globalState.addLog('warn', '⚠️ Erro ao verificar mensagens, tentando...');
      }

      await new Promise<void>((r) => setTimeout(r, 2000));
    }

    throw new Error(`⏰ Timeout aguardando OTP (${Math.round(timeoutMs / 1000)}s)`);
  }

  async createEmailAndWaitOTP(timeoutMs = 30000): Promise<{ email: string; md5: string; otp: string }> {
    const emailAccount = await this.createRandomEmail();
    globalState.addLog('info', `📧 Email criado: ${emailAccount.email}`);
    const otp = await this.waitForOTP(emailAccount.md5, timeoutMs);
    return { email: emailAccount.email, md5: emailAccount.md5, otp };
  }
}
