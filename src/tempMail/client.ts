import fetch from 'node-fetch';
import { globalState } from '../state/globalState';
import {
  EmailAccount,
  MailMessage,
  TempMailConfig,
} from '../types/tempMail';
import { OTPParser } from '../utils/otpParser';

// API temp-mail.io — documentacao: https://docs.temp-mail.io/docs/getting-started
// POST /v1/emails                  -> cria inbox
// GET  /v1/emails/{email}/messages -> lista mensagens (usa 1 crédito por chamada)
// GET  /v1/messages/{id}           -> busca mensagem completa

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

      return await response.json() as T;
    } catch (error) {
      clearTimeout(timeoutId);
      const message = error instanceof Error ? error.message : 'Erro desconhecido';
      // Só loga erros reais (não polling silencioso)
      globalState.addLog('error', `❌ Temp-Mail ${endpoint}: ${message}`);
      throw error;
    }
  }

  async createRandomEmail(): Promise<EmailAccount> {
    globalState.addLog('info', '📧 Criando email temporário...');
    const data = await this.request<{ email: string; ttl: number }>(
      '/v1/emails',
      'POST'
    );
    return {
      email: data.email,
      md5: data.email,
      quota: 0,
      used: 0,
      created_at: new Date().toISOString(),
    } as unknown as EmailAccount;
  }

  async listMessages(email: string): Promise<MailMessage[]> {
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
    return this.request<{ body_text: string; body_html: string }>(`/v1/messages/${messageId}`);
  }

  async getAvailableDomains(): Promise<string[]> {
    const data = await this.request<{ domains: string[] }>('/v1/domains');
    return data.domains ?? [];
  }

  /**
   * Aguarda o OTP minimizando o uso de créditos:
   * - Espera 8s antes da primeira verificação (email demora para chegar)
   * - Polling a cada 8s (era 3s → 62% menos chamadas)
   * - Só busca o corpo completo de mensagens novas
   * - Não loga cada polling — só loga eventos relevantes
   */
  async waitForOTP(email: string, timeoutMs = 60000): Promise<string> {
    const startTime = Date.now();
    let lastMessageCount = 0;
    const POLL_INTERVAL_MS = 8000; // 8s entre verificações para economizar créditos
    const INITIAL_WAIT_MS  = 8000; // espera inicial antes do primeiro check

    globalState.addLog('info', `⏳ Aguardando OTP (${Math.round(timeoutMs / 1000)}s, poll cada ${POLL_INTERVAL_MS / 1000}s)...`);

    // Aguarda inicial — email raramente chega antes de 8s
    await new Promise<void>((r) => setTimeout(r, INITIAL_WAIT_MS));

    while (Date.now() - startTime < timeoutMs) {
      if ((globalState.getState() as { shouldStop?: boolean }).shouldStop) {
        throw new Error('Parado pelo usuário durante espera do OTP');
      }

      try {
        const messages = await this.listMessages(email);

        if (messages.length > lastMessageCount) {
          globalState.addLog('info', `📨 ${messages.length} mensagem(s) recebida(s) — verificando OTP...`);

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
              // ignora erro ao buscar corpo individual
            }
          }
        }

        lastMessageCount = messages.length;
      } catch (e) {
        if (e instanceof Error && e.message.includes('Parado')) throw e;
        globalState.addLog('warn', '⚠️ Erro ao verificar mensagens, tentando novamente...');
      }

      await new Promise<void>((r) => setTimeout(r, POLL_INTERVAL_MS));
    }

    throw new Error(`⏰ Timeout aguardando OTP (${Math.round(timeoutMs / 1000)}s)`);
  }

  async createEmailAndWaitOTP(
    timeoutMs = 60000
  ): Promise<{ email: string; md5: string; otp: string }> {
    const emailAccount = await this.createRandomEmail();
    globalState.addLog('info', `📧 Email criado: ${emailAccount.email}`);
    const otp = await this.waitForOTP(emailAccount.email, timeoutMs);
    return { email: emailAccount.email, md5: emailAccount.email, otp };
  }
}
