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

    const domain = domains[Math.floor(Math.random() * domains.length)].domain;
    const localPart = 'user' + Math.random().toString(36).slice(2, 10);
    const address = `${localPart}@${domain}`;
    const password = this.generatePassword();

    globalState.addLog('info', `📧 [mail.tm] Criando conta: ${address}`);
    await withRetry(
      'mail.tm createAccount',
      () => this.request<{ id: string; address: string }>('/accounts', 'POST', { address, password })
    );

    const tokenResp = await withRetry(
      'mail.tm getToken',
      () => this.request<{ id: string; token: string }>('/token', 'POST', { address, password })
    );
    this.authToken = tokenResp.token;
    this.accountEmail = address;
    this.accountPassword = password;

    globalState.addLog('info', `✅ [mail.tm] Conta criada e autenticada: ${address}`);
    return { email: address, token: tokenResp.token };
  }

  private async listMessages(): Promise<MailTmMessageSummary[]> {
    const resp = await this.request<{ 'hydra:member': MailTmMessageSummary[] }>(
      '/messages?page=1', 'GET', undefined, true
    );
    return resp['hydra:member'] ?? [];
  }

  private async getFullMessage(id: string): Promise<{ html: string; text: string }> {
    const resp = await this.request<MailTmMessageFull>(`/messages/${id}`, 'GET', undefined, true);
    const html = Array.isArray(resp.html) ? resp.html.join('\n') : (resp.html ?? '');
    const text = (typeof resp.text === 'string' && resp.text.trim().length > 0)
      ? resp.text
      : (resp.intro ?? '');
    return { html, text };
  }

  async waitForOTP(email: string, timeoutMs = 90000, cycle?: number): Promise<string> {
    const startTime = Date.now();
    let lastMessageCount = 0;
    const POLL_INTERVAL_MS = 5_000;
    const INITIAL_WAIT_MS  = 6_000;

    globalState.addLog('info', `⏳ [mail.tm] Aguardando OTP para ${email} (${Math.round(timeoutMs / 1000)}s)...`, cycle);
    if (!this.authToken) throw new Error('Mail.tm: não autenticado — chame createRandomEmail() primeiro');

    globalState.addLog('info', `⏳ [mail.tm] Espera inicial de ${INITIAL_WAIT_MS / 1000}s...`, cycle);
    await sleep(INITIAL_WAIT_MS);

    let tentativaPoll = 0;
    while (Date.now() - startTime < timeoutMs) {
      if (isStopped()) throw new Error('Parado pelo usuário');

      tentativaPoll++;
      globalState.addLog('info', `🔄 [mail.tm] Poll #${tentativaPoll} — buscando mensagens...`, cycle);

      try {
        const messages = await withRetry('mail.tm listMessages', () => this.listMessages(), 3, 1500);
        globalState.addLog('info', `📬 [mail.tm] ${messages.length} mensagem(s) (anterior: ${lastMessageCount})`, cycle);

        if (messages.length > lastMessageCount) {
          const novas = messages.slice(lastMessageCount);
          globalState.addLog('info', `📨 [mail.tm] ${novas.length} mensagem(s) nova(s) — verificando OTP...`, cycle);

          for (const msg of novas.reverse()) {
            globalState.addLog('info', `📧 [mail.tm] Lendo: "${msg.subject}" de ${msg.from.address}`, cycle);
            try {
              const full = await withRetry('mail.tm getFullMessage', () => this.getFullMessage(msg.id), 3, 1500);
              globalState.addLog('info', `📄 [mail.tm] html(300): ${full.html.slice(0, 300)}`, cycle);
              globalState.addLog('info', `📄 [mail.tm] text(300): ${full.text.slice(0, 300)}`, cycle);

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

              const otp = await OTPParser.extractFromMessageAsync(mailMsg);
              if (otp) {
                globalState.addLog('success', `🎉 [mail.tm] OTP encontrado: ${otp}`, cycle);
                return otp;
              }
              globalState.addLog('warn', `⚠️ [mail.tm] Nenhum OTP extraído de "${msg.subject}"`, cycle);
            } catch (e) {
              globalState.addLog('warn', `⚠️ [mail.tm] Erro ao ler mensagem ${msg.id}: ${e instanceof Error ? e.message : e}`, cycle);
            }
          }
          lastMessageCount = messages.length;
        } else {
          globalState.addLog('info', `💭 [mail.tm] Sem mensagens novas — próximo poll em ${POLL_INTERVAL_MS / 1000}s`, cycle);
        }
      } catch (e) {
        if (e instanceof Error && e.message.includes('Parado')) throw e;
        globalState.addLog('warn', `⚠️ [mail.tm] Erro no poll #${tentativaPoll}: ${e instanceof Error ? e.message : e}`, cycle);
      }

      await sleep(POLL_INTERVAL_MS);
    }
    throw new Error(`⏰ Timeout aguardando OTP mail.tm (${Math.round(timeoutMs / 1000)}s)`);
  }
}

// ──────────────────────────────────────────────────────────────────────────────────
// YOPmailClient  (yopmail.com aliases — api.yopmail.com)
//
// Utiliza APENAS domínios alias do YOPmail, nunca @yopmail.com nem @yopmail.fr.
// Domínios alias disponíveis (todos roteiam para a mesma caixa de entrada):
//   yopmail.net, cool.fr.nf, jetable.fr.nf, krovatka.su, moncourrier.fr.nf,
//   monemail.fr.nf, monmail.fr.nf
// ──────────────────────────────────────────────────────────────────────────────────

// Domínios alias do YOPmail (excluídos yopmail.com e yopmail.fr)
const YOPMAIL_ALIAS_DOMAINS = [
  'yopmail.net',
  'cool.fr.nf',
  'jetable.fr.nf',
  'krovatka.su',
  'moncourrier.fr.nf',
  'monemail.fr.nf',
  'monmail.fr.nf',
];

export class YOPmailClient implements IEmailClient {
  private readonly apiBase = 'https://api.yopmail.com/api';
  // local-part gerado em createRandomEmail e reutilizado em waitForOTP
  private localPart: string | null = null;
  private domain: string | null = null;

  // Gera uma string alfanumérica aleatória de comprimento `len`
  private randStr(len = 10): string {
    const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
    let s = '';
    for (let i = 0; i < len; i++) s += chars[Math.floor(Math.random() * chars.length)];
    return s;
  }

  // Escolhe um domínio alias aleatório
  private pickDomain(): string {
    return YOPMAIL_ALIAS_DOMAINS[Math.floor(Math.random() * YOPMAIL_ALIAS_DOMAINS.length)];
  }

  async createRandomEmail(): Promise<EmailAccount> {
    this.localPart = this.randStr(10);
    this.domain    = this.pickDomain();
    const email = `${this.localPart}@${this.domain}`;

    // YOPmail não exige criação explícita de conta — a caixa de entrada é gerada
    // automaticamente no primeiro acesso. Apenas logamos e retornamos.
    globalState.addLog('info', `📧 [yopmail] Caixa gerada: ${email}`);
    return { email, token: this.localPart };
  }

  // Busca a lista de mensagens da caixa via API JSON pública do YOPmail
  private async fetchInbox(localPart: string): Promise<Array<{ id: string; from: string; subject: string; timestamp: string }>> {
    // Endpoint: GET /api/inbox?login=<local>&domain=<domain>&yp=<local>&p=1
    // Retorna JSON com campo "mail" (array de mails)
    const url = `${this.apiBase}/inbox?login=${encodeURIComponent(localPart)}&domain=${encodeURIComponent(this.domain!)}&yp=${encodeURIComponent(localPart)}&p=1`;
    const res = await safeFetch(url, {
      method: 'GET',
      headers: { 'Accept': 'application/json' },
      timeoutMs: 12000,
    });
    if (!res) throw new Error('yopmail inbox: erro de rede/timeout');
    const raw = await res.text();
    if (!res.ok) throw new Error(`yopmail inbox HTTP ${res.status}: ${raw.slice(0, 200)}`);
    const json = JSON.parse(raw) as {
      mail?: Array<{ id: string; yf?: string; ys?: string; yd?: string }>;
    };
    return (json.mail ?? []).map(m => ({
      id: m.id ?? '',
      from: m.yf ?? '',
      subject: m.ys ?? '',
      timestamp: m.yd ?? '',
    }));
  }

  // Busca o conteúdo completo de uma mensagem
  private async fetchMessage(localPart: string, msgId: string): Promise<{ html: string; text: string }> {
    const url = `${this.apiBase}/mail?login=${encodeURIComponent(localPart)}&domain=${encodeURIComponent(this.domain!)}&yp=${encodeURIComponent(localPart)}&id=${encodeURIComponent(msgId)}&d=0`;
    const res = await safeFetch(url, {
      method: 'GET',
      headers: { 'Accept': 'application/json' },
      timeoutMs: 12000,
    });
    if (!res) throw new Error('yopmail mail: erro de rede/timeout');
    const raw = await res.text();
    if (!res.ok) throw new Error(`yopmail mail HTTP ${res.status}: ${raw.slice(0, 200)}`);
    const json = JSON.parse(raw) as { mail?: { ymbody?: { html?: string; text?: string } } };
    const body = json.mail?.ymbody ?? {};
    return { html: body.html ?? '', text: body.text ?? '' };
  }

  async waitForOTP(email: string, timeoutMs = 90000, cycle?: number): Promise<string> {
    if (!this.localPart || !this.domain) {
      throw new Error('yopmail: createRandomEmail() deve ser chamado antes de waitForOTP()');
    }

    const startTime = Date.now();
    let lastCount = 0;
    const POLL_INTERVAL_MS = 6_000;
    const INITIAL_WAIT_MS  = 8_000;

    globalState.addLog('info', `⏳ [yopmail] Aguardando OTP para ${email} (${Math.round(timeoutMs / 1000)}s)...`, cycle);
    globalState.addLog('info', `⏳ [yopmail] Espera inicial de ${INITIAL_WAIT_MS / 1000}s...`, cycle);
    await sleep(INITIAL_WAIT_MS);

    let pollNum = 0;
    while (Date.now() - startTime < timeoutMs) {
      if (isStopped()) throw new Error('Parado pelo usuário');

      pollNum++;
      globalState.addLog('info', `🔄 [yopmail] Poll #${pollNum} — buscando inbox...`, cycle);

      try {
        const mails = await withRetry('yopmail fetchInbox', () => this.fetchInbox(this.localPart!), 3, 2000);
        globalState.addLog('info', `📬 [yopmail] ${mails.length} mensagem(s) (anterior: ${lastCount})`, cycle);

        if (mails.length > lastCount) {
          const novas = mails.slice(lastCount);
          globalState.addLog('info', `📨 [yopmail] ${novas.length} mensagem(s) nova(s) — verificando OTP...`, cycle);

          for (const m of novas.reverse()) {
            globalState.addLog('info', `📧 [yopmail] Lendo: "${m.subject}" de ${m.from}`, cycle);
            try {
              const full = await withRetry('yopmail fetchMessage', () => this.fetchMessage(this.localPart!, m.id), 3, 2000);
              globalState.addLog('info', `📄 [yopmail] html(300): ${full.html.slice(0, 300)}`, cycle);
              globalState.addLog('info', `📄 [yopmail] text(300): ${full.text.slice(0, 300)}`, cycle);

              const mailMsg: MailMessage = {
                mail_id: m.id,
                mail_from: m.from,
                mail_to: email,
                mail_subject: m.subject,
                mail_preview: '',
                mail_html: full.html,
                mail_text: full.text,
                created_at: m.timestamp,
              };

              const otp = await OTPParser.extractFromMessageAsync(mailMsg);
              if (otp) {
                globalState.addLog('success', `🎉 [yopmail] OTP encontrado: ${otp}`, cycle);
                return otp;
              }
              globalState.addLog('warn', `⚠️ [yopmail] Nenhum OTP extraído de "${m.subject}"`, cycle);
            } catch (e) {
              globalState.addLog('warn', `⚠️ [yopmail] Erro ao ler msg ${m.id}: ${e instanceof Error ? e.message : e}`, cycle);
            }
          }
          lastCount = mails.length;
        } else {
          globalState.addLog('info', `💭 [yopmail] Sem mensagens novas — próximo poll em ${POLL_INTERVAL_MS / 1000}s`, cycle);
        }
      } catch (e) {
        if (e instanceof Error && e.message.includes('Parado')) throw e;
        globalState.addLog('warn', `⚠️ [yopmail] Erro no poll #${pollNum}: ${e instanceof Error ? e.message : e}`, cycle);
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
