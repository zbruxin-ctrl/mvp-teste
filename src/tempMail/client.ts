import fetch from 'node-fetch';
import { globalState } from '../state/globalState';
import {
  EmailAccount,
  MailMessage,
  TempMailConfig,
  IEmailClient,
} from '../types/tempMail';
import { OTPParser } from '../utils/otpParser';

// ──────────────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────────────

function isStopped(): boolean {
  return !!(globalState.getState() as { shouldStop?: boolean }).shouldStop;
}

async function sleep(ms: number): Promise<void> {
  const step = 300;
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (isStopped()) throw new Error('Parado pelo usuário');
    await new Promise<void>(r => setTimeout(r, Math.min(step, end - Date.now())));
  }
}

async function safeFetch(
  url: string,
  options: Parameters<typeof fetch>[1] & { timeoutMs?: number }
): Promise<{ ok: boolean; status: number; text: () => Promise<string> } | null> {
  const { timeoutMs = 15000, ...fetchOpts } = options;
  const controller = new AbortController();
  const tid = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...fetchOpts, signal: controller.signal as AbortSignal });
    clearTimeout(tid);
    return res as unknown as { ok: boolean; status: number; text: () => Promise<string> };
  } catch {
    clearTimeout(tid);
    return null;
  }
}

async function withRetry<T>(
  label: string,
  fn: () => Promise<T>,
  maxAttempts = 3,
  baseDelayMs = 2000
): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (isStopped()) throw new Error('Parado pelo usuário');
    try {
      return await fn();
    } catch (e) {
      if (e instanceof Error && e.message.includes('Parado')) throw e;
      lastErr = e;
      const delay = baseDelayMs * attempt;
      globalState.addLog('warn', `⚠️ ${label} — tentativa ${attempt}/${maxAttempts} falhou, aguardando ${delay / 1000}s...`);
      if (attempt < maxAttempts) await sleep(delay);
    }
  }
  throw lastErr;
}

// ──────────────────────────────────────────────────────────────────────────────────
// TempMailClient  (temp-mail.io)
// ──────────────────────────────────────────────────────────────────────────────────
export class TempMailClient implements IEmailClient {
  private config: TempMailConfig;

  constructor(apiKey: string) {
    this.config = { apiKey, baseUrl: 'https://api.temp-mail.io' };
  }

  private async request<T>(endpoint: string, method: 'GET' | 'POST' = 'GET'): Promise<T> {
    const url = `${this.config.baseUrl}${endpoint}`;
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'X-API-Key': this.config.apiKey,
    };
    const res = await safeFetch(url, { method, headers });
    if (!res) throw new Error(`Temp-Mail ${endpoint}: erro de rede/timeout`);
    if (!res.ok) {
      const text = await res.text().catch(() => String(res.status));
      throw new Error(`Temp-Mail ${res.status}: ${text}`);
    }
    const text = await res.text();
    return text ? JSON.parse(text) as T : {} as T;
  }

  async createRandomEmail(): Promise<EmailAccount> {
    globalState.addLog('info', '📧 [temp-mail.io] Criando email temporário...');
    const data = await withRetry(
      'temp-mail.io createEmail',
      () => this.request<{ email: string; ttl: number }>('/v1/emails', 'POST')
    );
    globalState.addLog('info', `✅ [temp-mail.io] Email criado: ${data.email}`);
    return { email: data.email, token: data.email };
  }

  private async listMessages(email: string): Promise<MailMessage[]> {
    const data = await this.request<{
      messages: Array<{ id: string; from: string; subject: string; created_at: string }>;
    }>(`/v1/emails/${encodeURIComponent(email)}/messages`);
    return (data.messages ?? []).map(m => ({
      mail_id: m.id,
      mail_from: m.from,
      mail_to: email,
      mail_subject: m.subject,
      mail_preview: '',
      mail_html: '',
      mail_text: '',
      created_at: m.created_at,
    }));
  }

  private async getFullMessage(messageId: string): Promise<{ body_text: string; body_html: string }> {
    return this.request<{ body_text: string; body_html: string }>(`/v1/messages/${messageId}`);
  }

  async waitForOTP(email: string, timeoutMs = 90000, cycle?: number): Promise<string> {
    const startTime = Date.now();
    let lastMessageCount = 0;
    const POLL_INTERVAL_MS = 6_000;
    const INITIAL_WAIT_MS  = 8_000;

    globalState.addLog('info', `⏳ [temp-mail.io] Aguardando OTP (${Math.round(timeoutMs / 1000)}s)...`, cycle);
    await sleep(INITIAL_WAIT_MS);

    while (Date.now() - startTime < timeoutMs) {
      if (isStopped()) throw new Error('Parado pelo usuário');
      try {
        const messages = await withRetry('temp-mail.io listMessages', () => this.listMessages(email), 3, 1500);
        if (messages.length > lastMessageCount) {
          globalState.addLog('info', `📨 [temp-mail.io] ${messages.length} mensagem(s) — verificando OTP...`, cycle);
          for (const message of messages.slice(lastMessageCount).reverse()) {
            try {
              const full = await withRetry('temp-mail.io getFullMessage', () => this.getFullMessage(message.mail_id), 3, 1500);
              const mailMsg: MailMessage = { ...message, mail_text: full.body_text ?? '', mail_html: full.body_html ?? '' };
              const otp = await OTPParser.extractFromMessageAsync(mailMsg);
              if (otp) {
                globalState.addLog('success', `🎉 [temp-mail.io] OTP encontrado: ${otp}`, cycle);
                return otp;
              }
            } catch { /* mensagem individual falhou — continua */ }
          }
          lastMessageCount = messages.length;
        } else {
          globalState.addLog('info', `💭 [temp-mail.io] Sem mensagens novas — próximo poll em ${POLL_INTERVAL_MS / 1000}s`, cycle);
        }
      } catch (e) {
        if (e instanceof Error && e.message.includes('Parado')) throw e;
        globalState.addLog('warn', `⚠️ [temp-mail.io] Erro no poll: ${e instanceof Error ? e.message : e}`, cycle);
      }
      await sleep(POLL_INTERVAL_MS);
    }
    throw new Error(`⏰ Timeout aguardando OTP temp-mail.io (${Math.round(timeoutMs / 1000)}s)`);
  }
}

// ──────────────────────────────────────────────────────────────────────────────────
// MailTmClient  (mail.tm)
// ──────────────────────────────────────────────────────────────────────────────────

interface MailTmMessageSummary {
  id: string;
  from: { address: string; name: string };
  subject: string;
  createdAt: string;
  seen: boolean;
}

interface MailTmMessageFull {
  id: string;
  from: { address: string; name: string };
  subject: string;
  createdAt: string;
  seen: boolean;
  html: string[];
  text: string;
  intro: string;
}

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

    const res = await safeFetch(url, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });

    if (!res) throw new Error(`Mail.tm ${endpoint}: erro de rede/timeout`);

    if (res.status === 401 && auth) {
      globalState.addLog('warn', '🔑 [mail.tm] Token expirado — reautenticando...');
      await this.relogin();
      const headers2: Record<string, string> = { 'Content-Type': 'application/json' };
      if (this.authToken) headers2['Authorization'] = `Bearer ${this.authToken}`;
      const res2 = await safeFetch(url, {
        method,
        headers: headers2,
        body: body ? JSON.stringify(body) : undefined,
      });
      if (!res2 || !res2.ok) {
        const errText = res2 ? await res2.text().catch(() => '') : 'null';
        throw new Error(`Mail.tm ${res2?.status ?? 'null'}: ${errText}`);
      }
      const t2 = await res2.text();
      return t2 ? JSON.parse(t2) as T : {} as T;
    }

    if (!res.ok) {
      const text = await res.text().catch(() => String(res.status));
      throw new Error(`Mail.tm ${res.status}: ${text}`);
    }
    const text = await res.text();
    return text ? JSON.parse(text) as T : {} as T;
  }

  private async relogin(): Promise<void> {
    if (!this.accountEmail || !this.accountPassword) {
      throw new Error('Mail.tm: credenciais não disponíveis para relogin');
    }
    const tokenResp = await withRetry(
      'mail.tm relogin',
      () => this.request<{ id: string; token: string }>('/token', 'POST', {
        address: this.accountEmail,
        password: this.accountPassword,
      })
    );
    this.authToken = tokenResp.token;
    globalState.addLog('info', '✅ [mail.tm] Reautenticado com sucesso');
  }

  async createRandomEmail(): Promise<EmailAccount> {
    globalState.addLog('info', '📧 [mail.tm] Buscando domínios disponíveis...');
    const domainsResp = await withRetry(
      'mail.tm getDomains',
      () => this.request<{ 'hydra:member': Array<{ domain: string; isActive: boolean }> }>('/domains?page=1')
    );
    const domains = domainsResp['hydra:member']?.filter(d => d.isActive);
    if (!domains || domains.length === 0) throw new Error('Mail.tm: nenhum domínio disponível');

    const domain = domains[Math.floor(Math.random() * domains.length)]!.domain;
    const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
    let localPart = '';
    for (let i = 0; i < 12; i++) localPart += chars[Math.floor(Math.random() * chars.length)];
    const email = `${localPart}@${domain}`;
    const password = this.generatePassword();

    globalState.addLog('info', `📧 [mail.tm] Criando conta: ${email}`);
    await withRetry(
      'mail.tm createAccount',
      () => this.request('/accounts', 'POST', { address: email, password })
    );

    const tokenResp = await withRetry(
      'mail.tm getToken',
      () => this.request<{ id: string; token: string }>('/token', 'POST', { address: email, password })
    );

    this.authToken = tokenResp.token;
    this.accountEmail = email;
    this.accountPassword = password;

    globalState.addLog('info', `✅ [mail.tm] Email criado: ${email}`);
    return { email, token: tokenResp.token };
  }

  async waitForOTP(email: string, timeoutMs = 90000, cycle?: number): Promise<string> {
    const startTime = Date.now();
    let lastMessageCount = 0;
    const POLL_INTERVAL_MS = 6_000;
    const INITIAL_WAIT_MS  = 8_000;

    globalState.addLog('info', `⏳ [mail.tm] Aguardando OTP (${Math.round(timeoutMs / 1000)}s)...`, cycle);
    await sleep(INITIAL_WAIT_MS);

    while (Date.now() - startTime < timeoutMs) {
      if (isStopped()) throw new Error('Parado pelo usuário');
      try {
        const data = await withRetry(
          'mail.tm listMessages',
          () => this.request<{ 'hydra:member': MailTmMessageSummary[] }>('/messages', 'GET', undefined, true),
          3, 1500
        );
        const messages = data['hydra:member'] ?? [];

        if (messages.length > lastMessageCount) {
          globalState.addLog('info', `📨 [mail.tm] ${messages.length} mensagem(s) — verificando OTP...`, cycle);
          for (const msg of messages.slice(lastMessageCount).reverse()) {
            try {
              const full = await withRetry(
                'mail.tm getMessage',
                () => this.request<MailTmMessageFull>(`/messages/${msg.id}`, 'GET', undefined, true),
                3, 1500
              );
              const mailMsg: MailMessage = {
                mail_id:      full.id,
                mail_from:    full.from?.address ?? '',
                mail_to:      email,
                mail_subject: full.subject ?? '',
                mail_preview: full.intro ?? '',
                mail_html:    full.html?.join('') ?? '',
                mail_text:    full.text ?? '',
                created_at:   full.createdAt,
              };
              const otp = await OTPParser.extractFromMessageAsync(mailMsg);
              if (otp) {
                globalState.addLog('success', `🎉 [mail.tm] OTP encontrado: ${otp}`, cycle);
                return otp;
              }
            } catch { /* mensagem individual falhou — continua */ }
          }
          lastMessageCount = messages.length;
        } else {
          globalState.addLog('info', `💭 [mail.tm] Sem mensagens novas — próximo poll em ${POLL_INTERVAL_MS / 1000}s`, cycle);
        }
      } catch (e) {
        if (e instanceof Error && e.message.includes('Parado')) throw e;
        globalState.addLog('warn', `⚠️ [mail.tm] Erro no poll: ${e instanceof Error ? e.message : e}`, cycle);
      }
      await sleep(POLL_INTERVAL_MS);
    }
    throw new Error(`⏰ Timeout aguardando OTP mail.tm (${Math.round(timeoutMs / 1000)}s)`);
  }
}

// ──────────────────────────────────────────────────────────────────────────────────
// YOPmailClient
// ──────────────────────────────────────────────────────────────────────────────────
// Usa @yopmail.com diretamente — domínio principal aceito pelo site-alvo.
// A lib easy-yopmail só precisa do local part para consultar a inbox.
// ──────────────────────────────────────────────────────────────────────────────────

// Tipo retornado por getInbox() conforme documentação easy-yopmail
interface YopInboxResult {
  inbox: Array<{ id: string; subject: string; from: string; timestamp?: string; page?: number }>;
}

export class YOPmailClient implements IEmailClient {
  private inbox: string = '';
  private email: string = '';

  private generateInbox(): string {
    const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
    let name = '';
    for (let i = 0; i < 10; i++) name += chars[Math.floor(Math.random() * chars.length)];
    return name;
  }

  async createRandomEmail(): Promise<EmailAccount> {
    this.inbox = this.generateInbox();
    this.email = `${this.inbox}@yopmail.com`;
    globalState.addLog('info', `📧 [yopmail] Email criado: ${this.email}`);
    return { email: this.email, token: this.inbox };
  }

  // ─── Extrai OTP do subject sem chamar readMessage ────────────────────────────
  private tryOtpFromSubject(subject: string): string | null {
    const m = subject.match(/\b(\d{4,8})\b/);
    return m ? m[1]! : null;
  }

  // ─── Tenta ler o corpo com múltiplas estratégias ─────────────────────────────
  private async readBodyRobust(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    EasyYopmail: any,
    id: string,
    cycle?: number
  ): Promise<string> {
    // Estratégia 1: format HTML + selector #mail (conteúdo principal)
    try {
      const r = await EasyYopmail.readMessage(this.inbox, id, { format: 'HTML', selector: '#mail' });
      const body = r?.content ?? r?.data ?? '';
      const bodyStr = Array.isArray(body) ? body.join(' ') : String(body);
      if (bodyStr && !bodyStr.includes('CAPTCHA') && bodyStr.trim().length > 10) {
        globalState.addLog('info', `📄 [yopmail] body via HTML#mail (300): ${bodyStr.slice(0, 300)}`, cycle);
        return bodyStr;
      }
    } catch (e) {
      globalState.addLog('warn', `⚠️ [yopmail] readMessage HTML#mail falhou: ${e instanceof Error ? e.message : e}`, cycle);
    }

    // Estratégia 2: format HTML sem selector (html completo)
    try {
      const r = await EasyYopmail.readMessage(this.inbox, id, { format: 'HTML' });
      const body = r?.content ?? r?.data ?? '';
      const bodyStr = Array.isArray(body) ? body.join(' ') : String(body);
      if (bodyStr && !bodyStr.includes('CAPTCHA') && bodyStr.trim().length > 10) {
        globalState.addLog('info', `📄 [yopmail] body via HTML full (300): ${bodyStr.slice(0, 300)}`, cycle);
        return bodyStr;
      }
    } catch (e) {
      globalState.addLog('warn', `⚠️ [yopmail] readMessage HTML full falhou: ${e instanceof Error ? e.message : e}`, cycle);
    }

    // Estratégia 3: format TXT via objeto options (API v5)
    try {
      const r = await EasyYopmail.readMessage(this.inbox, id, { format: 'TXT' });
      const body = r?.content ?? r?.data ?? '';
      const bodyStr = Array.isArray(body) ? body.join(' ') : String(body);
      if (bodyStr && !bodyStr.includes('CAPTCHA') && bodyStr.trim().length > 10) {
        globalState.addLog('info', `📄 [yopmail] body via TXT-obj (300): ${bodyStr.slice(0, 300)}`, cycle);
        return bodyStr;
      }
    } catch (e) {
      globalState.addLog('warn', `⚠️ [yopmail] readMessage TXT-obj falhou: ${e instanceof Error ? e.message : e}`, cycle);
    }

    // Estratégia 4: assinatura legada string (compatibilidade com versões antigas)
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const r = await (EasyYopmail.readMessage as any)(this.inbox, id, 'TXT');
      const body = r?.content ?? r?.data ?? '';
      const bodyStr = Array.isArray(body) ? body.join(' ') : String(body);
      globalState.addLog('info', `📄 [yopmail] body via TXT-str (300): ${bodyStr.slice(0, 300)}`, cycle);
      return bodyStr;
    } catch (e) {
      globalState.addLog('warn', `⚠️ [yopmail] readMessage TXT-str falhou: ${e instanceof Error ? e.message : e}`, cycle);
    }

    return '';
  }

  async waitForOTP(email: string, timeoutMs = 120_000, cycle?: number): Promise<string> {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const EasyYopmail = require('easy-yopmail');

    const startTime = Date.now();
    const POLL_INTERVAL_MS = 7_000;
    const INITIAL_WAIT_MS  = 10_000;
    let lastCount = 0;
    let poll = 0;

    globalState.addLog('info', `⏳ [yopmail] Aguardando OTP para ${this.email} (${Math.round(timeoutMs / 1000)}s)...`, cycle);
    globalState.addLog('info', `⏳ [yopmail] Espera inicial de ${INITIAL_WAIT_MS / 1000}s...`, cycle);
    await sleep(INITIAL_WAIT_MS);

    while (Date.now() - startTime < timeoutMs) {
      if (isStopped()) throw new Error('Parado pelo usuário');

      poll++;
      globalState.addLog('info', `🔄 [yopmail] Poll #${poll} — verificando inbox ${this.inbox}...`, cycle);

      try {
        // Cast explícito para YopInboxResult evita TS18046 ('result' is of type 'unknown')
        const result = await withRetry<YopInboxResult>(
          'yopmail getInbox',
          () => EasyYopmail.getInbox(this.inbox) as Promise<YopInboxResult>,
          3, 3000
        );

        const messages = Array.isArray(result.inbox) ? result.inbox : [];
        globalState.addLog('info', `📬 [yopmail] ${messages.length} mensagem(s) (anterior: ${lastCount})`, cycle);

        if (messages.length > lastCount) {
          const novas = messages.slice(lastCount);
          globalState.addLog('info', `📨 [yopmail] ${novas.length} mensagem(s) nova(s) — verificando OTP...`, cycle);

          for (const msg of novas) {
            globalState.addLog('info', `📧 [yopmail] Lendo: "${msg.subject}" de ${msg.from}`, cycle);

            // Estratégia 0: OTP direto no subject (evita chamar readMessage)
            const otpSubject = this.tryOtpFromSubject(msg.subject ?? '');
            if (otpSubject) {
              globalState.addLog('success', `🎉 [yopmail] OTP no subject: ${otpSubject}`, cycle);
              return otpSubject;
            }

            // Estratégias 1-4: ler o corpo com retry e backoff maior
            try {
              const bodyStr = await withRetry(
                'yopmail readBody',
                () => this.readBodyRobust(EasyYopmail, msg.id, cycle),
                3, 4000
              );

              const mailMsg: MailMessage = {
                mail_id:      msg.id,
                mail_from:    msg.from,
                mail_to:      this.email,
                mail_subject: msg.subject ?? '',
                mail_preview: '',
                mail_html:    bodyStr,
                mail_text:    bodyStr,
                created_at:   new Date().toISOString(),
              };

              const otp = await OTPParser.extractFromMessageAsync(mailMsg);
              if (otp) {
                globalState.addLog('success', `🎉 [yopmail] OTP encontrado: ${otp}`, cycle);
                return otp;
              }
              globalState.addLog('warn', `⚠️ [yopmail] Nenhum OTP extraído de "${msg.subject}"`, cycle);
            } catch (e) {
              globalState.addLog('warn', `⚠️ [yopmail] Erro ao ler mensagem ${msg.id}: ${e instanceof Error ? e.message : e}`, cycle);
            }
          }
          lastCount = messages.length;
        } else {
          globalState.addLog('info', `💭 [yopmail] Sem mensagens novas — próximo poll em ${POLL_INTERVAL_MS / 1000}s`, cycle);
        }
      } catch (e) {
        if (e instanceof Error && e.message.includes('Parado')) throw e;
        globalState.addLog('warn', `⚠️ [yopmail] Erro no poll #${poll}: ${e instanceof Error ? e.message : e}`, cycle);
      }

      await sleep(POLL_INTERVAL_MS);
    }
    throw new Error(`⏰ Timeout aguardando OTP yopmail (${Math.round(timeoutMs / 1000)}s)`);
  }
}

export function createEmailClient(
  provider: 'temp-mail.io' | 'mail.tm' | 'yopmail',
  apiKey?: string
): IEmailClient {
  if (provider === 'mail.tm')  return new MailTmClient();
  if (provider === 'yopmail')  return new YOPmailClient();
  if (!apiKey) throw new Error('temp-mail.io requer uma API key');
  return new TempMailClient(apiKey);
}
