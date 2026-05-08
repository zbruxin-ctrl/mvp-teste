import fetch from 'node-fetch';
import { globalState } from '../state/globalState';
import {
  EmailAccount,
  MailMessage,
  TempMailConfig,
} from '../types/tempMail';
import { OTPParser } from '../utils/otpParser';

// Endpoints reais da API tempmail.lol (plano Pro/Plus/Ultra):
// GET  https://api.tempmail.lol/generate        -> cria inbox, retorna { address, token }
// GET  https://api.tempmail.lol/auth/<token>     -> lista mensagens do inbox
// Autenticacao: Authorization: Bearer <apiKey> no header (plano pago)

export class TempMailClient {
  private config: TempMailConfig;

  constructor(apiKey: string) {
    this.config = {
      apiKey,
      baseUrl: 'https://api.tempmail.lol',
    };
  }

  private async request<T>(endpoint: string): Promise<T> {
    const url = `${this.config.baseUrl}${endpoint}`;

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };

    // Plano Pro/Plus/Ultra: autenticacao via Bearer token no header
    if (this.config.apiKey) {
      headers['Authorization'] = `Bearer ${this.config.apiKey}`;
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 15000);

    try {
      globalState.addLog('info', `📧 Temp-Mail: GET ${endpoint}`);

      const response = await fetch(url, {
        method: 'GET',
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
    // GET /generate -> { address: string, token: string }
    const data = await this.request<{ address: string; token: string }>('/generate');
    return {
      email: data.address,
      token: data.token,
    } as unknown as EmailAccount;
  }

  async listMessages(emailToken: string): Promise<MailMessage[]> {
    // GET /auth/<token> -> { token: string, email: string, messages: MailMessage[] | null }
    const data = await this.request<{ token: string; email: string; messages: MailMessage[] | null }>(
      `/auth/${emailToken}`
    );
    return data.messages ?? [];
  }

  async getAvailableDomains(): Promise<string[]> {
    const data = await this.request<{ domains: string[] }>('/domains');
    return data.domains ?? [];
  }

  async waitForOTP(emailToken: string, timeoutMs = 30000): Promise<string> {
    const startTime = Date.now();
    let lastMessageCount = 0;

    globalState.addLog(
      'info',
      `⏳ Aguardando OTP (${Math.round(timeoutMs / 1000)}s)...`
    );

    while (Date.now() - startTime < timeoutMs) {
      if ((globalState.getState() as { shouldStop?: boolean }).shouldStop) {
        throw new Error('Parado pelo usuário durante espera do OTP');
      }

      try {
        const messages = await this.listMessages(emailToken);

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
  ): Promise<{ email: string; token: string; otp: string }> {
    const emailAccount = await this.createRandomEmail();
    const token = (emailAccount as unknown as { token: string }).token;
    globalState.addLog('info', `📧 Email criado: ${emailAccount.email}`);
    const otp = await this.waitForOTP(token, timeoutMs);
    return { email: emailAccount.email, token, otp };
  }
}
