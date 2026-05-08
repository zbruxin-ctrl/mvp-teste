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
      // FIX 1: URL correta da API pública do Temp-Mail LOL (sem /v1)
      apiKey,
      baseUrl: 'https://api.tempmail.lol',
    };
  }

  private async request<T>(
    endpoint: string,
    options: Record<string, unknown> = {}
  ): Promise<T> {
    const url = `${this.config.baseUrl}${endpoint}`;
    const headers: Record<string, string> = {
      // FIX 2: header correto da API é Authorization, não X-API-Key
      Authorization: `Bearer ${this.config.apiKey}`,
      'Content-Type': 'application/json',
      ...((options.headers as Record<string, string>) || {}),
    };

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 15000);

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
        const errorData = await response
          .json()
          .catch(() => ({})) as Record<string, unknown>;
        throw new Error(
          `Temp-Mail ${response.status}: ${
            (errorData.message as string) || response.statusText
          }`
        );
      }

      const data = (await response.json()) as T & {
        success?: boolean;
        action_status?: string;
      };

      if (data.success === false) {
        throw new Error(
          `Temp-Mail falhou: ${data.action_status || 'Erro desconhecido'}`
        );
      }

      globalState.addLog('success', `✅ Temp-Mail OK: ${endpoint}`);
      return data;
    } catch (error) {
      clearTimeout(timeoutId);
      const message =
        error instanceof Error ? error.message : 'Erro desconhecido';
      globalState.addLog('error', `❌ Temp-Mail ${endpoint}: ${message}`);
      throw error;
    }
  }

  async createRandomEmail(): Promise<EmailAccount> {
    // FIX 3: endpoint correto é /generate (não /email)
    const data = await this.request<EmailAccount>('/generate/v2');
    return data;
  }

  async listMessages(emailToken: string): Promise<MailMessage[]> {
    // FIX 4: endpoint usa token, não md5
    const data = await this.request<{ token: string; email: string; messages: MailMessage[] }>(
      `/auth/${emailToken}`
    );
    return data.messages || [];
  }

  async getMessage(
    emailToken: string,
    messageId: string
  ): Promise<MailMessage> {
    const data = await this.request<{ message: MailMessage }>(
      `/auth/${emailToken}/${messageId}`
    );
    return data.message;
  }

  async getAvailableDomains(): Promise<string[]> {
    const data = await this.request<{ domains: string[] }>('/domains');
    return data.domains || [];
  }

  async waitForOTP(emailToken: string, timeoutMs = 30000): Promise<string> {
    const startTime = Date.now();
    let lastMessageCount = 0;

    globalState.addLog(
      'info',
      `⏳ Aguardando OTP (${Math.round(timeoutMs / 1000)}s)...`
    );

    while (Date.now() - startTime < timeoutMs) {
      // FIX 5: checa shouldStop para não ficar preso se usuário parar
      if ((globalState.getState() as { shouldStop?: boolean }).shouldStop) {
        throw new Error('Parado pelo usuário durante espera do OTP');
      }

      try {
        const messages = await this.listMessages(emailToken);

        if (messages.length > lastMessageCount) {
          globalState.addLog(
            'info',
            `📨 ${messages.length} mensagem(s) recebida(s)`
          );

          for (const message of messages.slice().reverse()) {
            const otp = OTPParser.extractFromMessage(message);
            if (otp) {
              globalState.addLog('success', `🎉 OTP: ${otp}`);
              return otp;
            }
          }
        }

        lastMessageCount = messages.length;
      } catch (e) {
        // só loga se não for o erro de parada
        if (e instanceof Error && e.message.includes('Parado')) throw e;
        globalState.addLog('warn', '⚠️ Erro ao verificar mensagens, tentando...');
      }

      await new Promise<void>((r) => setTimeout(r, 3000));
    }

    throw new Error(
      `⏰ Timeout aguardando OTP (${Math.round(timeoutMs / 1000)}s)`
    );
  }

  async createEmailAndWaitOTP(
    timeoutMs = 30000
  ): Promise<{ email: string; token: string; otp: string }> {
    const emailAccount = await this.createRandomEmail();
    globalState.addLog('info', `📧 Email criado: ${emailAccount.email}`);
    // FIX 6: usa token (não md5) para checar inbox
    const token = (emailAccount as unknown as { token: string }).token;
    const otp = await this.waitForOTP(token, timeoutMs);
    return { email: emailAccount.email, token, otp };
  }
}
