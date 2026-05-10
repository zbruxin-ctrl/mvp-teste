import fetch from 'node-fetch';
import { globalState } from '../state/globalState';
import {
  EmailAccount,
  MailMessage,
  TempMailConfig,
  IEmailClient,
} from '../types/tempMail';
import { OTPParser } from '../utils/otpParser';

// ─────────────────────────────────────────────────────────────────────────────
// TempMailClient  (temp-mail.io)
// Docs: https://docs.temp-mail.io
// ─────────────────────────────────────────────────────────────────────────────
export class TempMailClient implements IEmailClient {
  private config: TempMailConfig;

  constructor(apiKey: string) {
    this.config = {
      apiKey,
      baseUrl: 'https://api.temp-mail.io',
    };
  }

  private async request<T>(endpoint: string, method: 'GET' | 'POST' = 'GET'): Promise<T> {
    const url = `${this.config.baseUrl}${endpoint}`;
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'X-API-Key': this.config.apiKey,
    };
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 15000);
    try {
      const response = await fetch(url, { method, headers, signal: controller.signal as AbortSignal });
      clearTimeout(timeoutId);
      if (!response.ok) {
        const text = await response.text().catch(() => response.statusText);
        throw new Error(`Temp-Mail ${response.status}: ${text}`);
      }
      return await response.json() as T;
    } catch (error) {
      clearTimeout(timeoutId);
      const message = error instanceof Error ? error.message : 'Erro desconhecido';
      globalState.addLog('error', `❌ Temp-Mail ${endpoint}: ${message}`);
      throw error;
    }
  }

  async createRandomEmail(): Promise<EmailAccount> {
    globalState.addLog('info', '📧 [temp-mail.io] Criando email temporário...');
    const data = await this.request<{ email: string; ttl: number }>('/v1/emails', 'POST');
    return { email: data.email, token: data.email };
  }

  async listMessages(email: string): Promise<MailMessage[]> {
    const data = await this.request<{ messages: Array<{ id: string; from: string; subject: string; created_at: string }> }>(
      `/v1/emails/${encodeURIComponent(email)}/messages`
    );
    return (data.messages ?? []).map(m => ({
      mail_id: m.id,
      mail_from: m.from,
      mail_to: email,
      mail_subject: m.subject,
      mail_preview: '',
      mail_html: '',
      mail_text: '',
      created_at: m.created_at,
    })) as MailMessage[];
  }

  async getFullMessage(messageId: string): Promise<{ body_text: string; body_html: string }> {
    return this.request<{ body_text: string; body_html: string }>(`/v1/messages/${messageId}`);
  }

  async waitForOTP(email: string, timeoutMs = 60000): Promise<string> {
    const startTime = Date.now();
    let lastMessageCount = 0;
    const POLL_INTERVAL_MS = 12_000;
    const INITIAL_WAIT_MS  = 15_000;

    globalState.addLog('info', `⏳ [temp-mail.io] Aguardando OTP (${Math.round(timeoutMs / 1000)}s)...`);

    const inicioEspera = Date.now();
    while (Date.now() - inicioEspera < INITIAL_WAIT_MS) {
      if ((globalState.getState() as { shouldStop?: boolean }).shouldStop) throw new Error('Parado pelo usuário');
      await new Promise<void>(r => setTimeout(r, 500));
    }

    while (Date.now() - startTime < timeoutMs) {
      if ((globalState.getState() as { shouldStop?: boolean }).shouldStop) throw new Error('Parado pelo usuário');
      try {
        const messages = await this.listMessages(email);
        if (messages.length > lastMessageCount) {
          globalState.addLog('info', `📨 ${messages.length} mensagem(s) recebida(s) — verificando OTP...`);
          for (const message of messages.slice(lastMessageCount).reverse()) {
            try {
              const full = await this.getFullMessage(message.mail_id);
              const msgWithBody = { ...message, mail_text: full.body_text ?? '', mail_html: full.body_html ?? '' };
              const otp = OTPParser.extractFromMessage(msgWithBody as MailMessage);
              if (otp) { globalState.addLog('success', `🎉 OTP encontrado: ${otp}`); return otp; }
            } catch { /* ignora erro individual */ }
          }
          // FIX: atualiza contador mesmo quando nenhum OTP foi encontrado nas mensagens novas
          lastMessageCount = messages.length;
        }
      } catch (e) {
        if (e instanceof Error && e.message.includes('Parado')) throw e;
        globalState.addLog('warn', '⚠️ Erro ao verificar mensagens temp-mail.io, tentando novamente...');
      }
      const fimPoll = Date.now() + POLL_INTERVAL_MS;
      while (Date.now() < fimPoll) {
        if ((globalState.getState() as { shouldStop?: boolean }).shouldStop) throw new Error('Parado pelo usuário');
        await new Promise<void>(r => setTimeout(r, 500));
      }
    }
    throw new Error(`⏰ Timeout aguardando OTP temp-mail.io (${Math.round(timeoutMs / 1000)}s)`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// MailTmClient  (mail.tm)
// Docs: https://docs.mail.tm
// Não requer API key — cria conta com endereço+senha e obtém JWT token.
// ─────────────────────────────────────────────────────────────────────────────
export class MailTmClient implements IEmailClient {
  private baseUrl = 'https://api.mail.tm';
  private authToken: string | null = null;
  private accountEmail: string | null = null;
  private accountPassword: string | null = null;

  private generatePassword(): string {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$';
    let pwd = '';
    for (let i = 0; i < 16; i++) pwd += chars[Math.floor(Math.random() * chars.length)];
    return pwd;
  }

  private async request<T>(
    endpoint: string,
    method: 'GET' | 'POST' = 'GET',
    body?: unknown,
    auth = false
  ): Promise<T> {
    const url = `${this.baseUrl}${endpoint}`;
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (auth && this.authToken) headers['Authorization'] = `Bearer ${this.authToken}`;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 15000);
    try {
      const response = await fetch(url, {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal as AbortSignal,
      });
      clearTimeout(timeoutId);
      if (!response.ok) {
        const text = await response.text().catch(() => response.statusText);
        throw new Error(`Mail.tm ${response.status}: ${text}`);
      }
      const text = await response.text();
      return text ? JSON.parse(text) as T : {} as T;
    } catch (error) {
      clearTimeout(timeoutId);
      const message = error instanceof Error ? error.message : 'Erro desconhecido';
      globalState.addLog('error', `❌ Mail.tm ${endpoint}: ${message}`);
      throw error;
    }
  }

  /** Busca um domínio disponível e cria uma conta com endereço aleatório */
  async createRandomEmail(): Promise<EmailAccount> {
    globalState.addLog('info', '📧 [mail.tm] Buscando domínios disponíveis...');

    // GET /domains — retorna lista paginada; pega o primeiro domínio ativo
    const domainsResp = await this.request<{ 'hydra:member': Array<{ domain: string; isActive: boolean }> }>(
      '/domains?page=1'
    );
    const domains = domainsResp['hydra:member']?.filter(d => d.isActive);
    if (!domains || domains.length === 0) throw new Error('Mail.tm: nenhum domínio disponível');

    const domain = domains[Math.floor(Math.random() * domains.length)].domain;
    const localPart = 'user' + Math.random().toString(36).slice(2, 10);
    const address = `${localPart}@${domain}`;
    const password = this.generatePassword();

    globalState.addLog('info', `📧 [mail.tm] Criando conta: ${address}`);

    // POST /accounts — cria a conta
    await this.request<{ id: string; address: string }>(
      '/accounts',
      'POST',
      { address, password }
    );

    // POST /token — obtém JWT
    const tokenResp = await this.request<{ id: string; token: string }>(
      '/token',
      'POST',
      { address, password }
    );

    this.authToken = tokenResp.token;
    this.accountEmail = address;
    this.accountPassword = password;

    globalState.addLog('info', `✅ [mail.tm] Conta criada e autenticada: ${address}`);
    return { email: address, token: tokenResp.token };
  }

  private async listMessages(): Promise<Array<{
    id: string; from: { address: string; name: string }; subject: string; createdAt: string; seen: boolean;
  }>> {
    const resp = await this.request<{ 'hydra:member': Array<{
      id: string; from: { address: string; name: string }; subject: string; createdAt: string; seen: boolean;
    }> }>('/messages?page=1', 'GET', undefined, true);
    return resp['hydra:member'] ?? [];
  }

  // FIX: API mail.tm retorna 'intro' em emails curtos (OTPs) em vez de 'text'.
  // Adicionado fallback: intro → text, para garantir que o OTP seja capturado.
  private async getFullMessage(id: string): Promise<{ text: string; html: string }> {
    const resp = await this.request<{ text?: string; html?: string; intro?: string }>(
      `/messages/${id}`,
      'GET',
      undefined,
      true
    );
    return {
      text: resp.text ?? resp.intro ?? '',
      html: resp.html ?? '',
    };
  }

  async waitForOTP(email: string, timeoutMs = 60000): Promise<string> {
    const startTime = Date.now();
    let lastMessageCount = 0;
    const POLL_INTERVAL_MS = 8_000;
    const INITIAL_WAIT_MS  = 20_000;

    globalState.addLog('info', `⏳ [mail.tm] Aguardando OTP para ${email} (${Math.round(timeoutMs / 1000)}s)...`);

    if (!this.authToken) throw new Error('Mail.tm: não autenticado — chame createRandomEmail() primeiro');

    const inicioEspera = Date.now();
    while (Date.now() - inicioEspera < INITIAL_WAIT_MS) {
      if ((globalState.getState() as { shouldStop?: boolean }).shouldStop) throw new Error('Parado pelo usuário');
      await new Promise<void>(r => setTimeout(r, 500));
    }

    while (Date.now() - startTime < timeoutMs) {
      if ((globalState.getState() as { shouldStop?: boolean }).shouldStop) throw new Error('Parado pelo usuário');
      try {
        const messages = await this.listMessages();
        if (messages.length > lastMessageCount) {
          globalState.addLog('info', `📨 [mail.tm] ${messages.length} mensagem(s) — verificando OTP...`);
          for (const msg of messages.slice(lastMessageCount).reverse()) {
            try {
              const full = await this.getFullMessage(msg.id);
              const mailMsg: MailMessage = {
                mail_id: msg.id,
                mail_from: msg.from.address,
                mail_to: email,
                mail_subject: msg.subject,
                mail_preview: '',
                mail_html: full.html,
                mail_text: full.text,
                created_at: msg.createdAt,
              };
              const otp = OTPParser.extractFromMessage(mailMsg);
              if (otp) { globalState.addLog('success', `🎉 [mail.tm] OTP encontrado: ${otp}`); return otp; }
            } catch { /* ignora erro individual */ }
          }
          // FIX: atualiza contador mesmo quando nenhum OTP foi encontrado nas mensagens novas,
          // evitando reprocessamento infinito das mesmas mensagens nas próximas iterações.
          lastMessageCount = messages.length;
        }
      } catch (e) {
        if (e instanceof Error && e.message.includes('Parado')) throw e;
        globalState.addLog('warn', '⚠️ Erro ao verificar mensagens mail.tm, tentando novamente...');
      }
      const fimPoll = Date.now() + POLL_INTERVAL_MS;
      while (Date.now() < fimPoll) {
        if ((globalState.getState() as { shouldStop?: boolean }).shouldStop) throw new Error('Parado pelo usuário');
        await new Promise<void>(r => setTimeout(r, 500));
      }
    }
    throw new Error(`⏰ Timeout aguardando OTP mail.tm (${Math.round(timeoutMs / 1000)}s)`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Factory — instancia o client correto com base no provider
// ─────────────────────────────────────────────────────────────────────────────
export function createEmailClient(provider: 'temp-mail.io' | 'mail.tm', apiKey?: string): IEmailClient {
  if (provider === 'mail.tm') {
    return new MailTmClient();
  }
  if (!apiKey) throw new Error('temp-mail.io requer uma API key');
  return new TempMailClient(apiKey);
}
