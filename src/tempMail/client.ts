import fetch from 'node-fetch';
import { globalState } from '../state/globalState';
import { 
  TempMailConfig, 
  CreateEmailResponse, 
  ListMessagesResponse, 
  GetMessageResponse,
  CreateDomainResponse,
  TempMailError
} from '../types/tempMail';
import { LogEntry } from '../types';

export class TempMailClient {
  private config: TempMailConfig;

  constructor(apiKey: string) {
    this.config = {
      apiKey,
      baseUrl: 'https://api.tempmail.lol/v1'
    };
  }

  private async request<T>(endpoint: string, options: RequestInit = {}): Promise<T> {
    const url = `${this.config.baseUrl}${endpoint}`;
    const headers = {
      'X-API-Key': this.config.apiKey,
      'Content-Type': 'application/json',
      ...options.headers
    };

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10000);

    try {
      globalState.addLog('info', `📧 Temp-Mail: ${endpoint}`);
      
      const response = await fetch(url, {
        ...options,
        headers,
        signal: controller.signal
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        const error: TempMailError = await response.json().catch(() => ({
          code: response.status,
          message: response.statusText
        }));
        throw new Error(`Temp-Mail ${response.status}: ${error.message}`);
      }

      const data = await response.json() as T;
      
      if (!data.success) {
        throw new Error(`Temp-Mail falhou: ${data.action_status || 'Erro desconhecido'}`);
      }

      globalState.addLog('success', `✅ Temp-Mail: ${endpoint} OK`);
      return data;

    } catch (error) {
      clearTimeout(timeoutId);
      const message = error instanceof Error ? error.message : 'Erro desconhecido';
      globalState.addLog('error', `❌ Temp-Mail: ${endpoint} - ${message}`);
      throw error;
    }
  }

  async createRandomEmail(): Promise<EmailAccount> {
    const data = await this.request<CreateEmailResponse>('/email');
    return data.emailaccount;
  }

  async listMessages(emailMd5: string): Promise<MailMessage[]> {
    const data = await this.request<ListMessagesResponse>(`/messages/${emailMd5}`);
    return data.messages;
  }

  async getMessage(emailMd5: string, messageId: string): Promise<MailMessage> {
    const data = await this.request<GetMessageResponse>(`/messages/${emailMd5}/${messageId}`);
    return data.message;
  }

  async getAvailableDomains(): Promise<string[]> {
    const data = await this.request<CreateDomainResponse>('/domains');
    return [data.domain];
  }

  async waitForEmail(emailMd5: string, timeoutMs = 30000): Promise<MailMessage> {
    const startTime = Date.now();
    
    while (Date.now() - startTime < timeoutMs) {
      try {
        const messages = await this.listMessages(emailMd5);
        if (messages.length > 0) {
          globalState.addLog('success', `📨 Email recebido: ${messages[0].mail_subject}`);
          return messages[0];
        }
      } catch (error) {
        // Continua tentando
      }
      
      globalState.addLog('info', '⏳ Aguardando email...');
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
    
    throw new Error(`Timeout aguardando email (${timeoutMs}ms)`);
  }
}

// ... imports existentes ...
import { OTPParser } from '../utils/otpParser';

export class TempMailClient {
  // ... métodos existentes ...

  /**
   * Aguarda email e extrai OTP automaticamente
   */
  async waitForOTP(emailMd5: string, timeoutMs = 30000): Promise<string> {
    const startTime = Date.now();
    let lastMessageCount = 0;

    globalState.addLog('info', `⏳ Aguardando OTP por ${Math.round(timeoutMs/1000)}s...`);

    while (Date.now() - startTime < timeoutMs) {
      try {
        const messages = await this.listMessages(emailMd5);
        
        // Nova mensagem chegou?
        if (messages.length > lastMessageCount) {
          globalState.addLog('info', `📨 ${messages.length} mensagem(s) recebida(s)`);
          
          for (const message of messages.slice(-2)) { // Últimas 2 mensagens
            const otp = OTPParser.extractFromMessage(message);
            if (otp) {
              globalState.addLog('success', `🎉 OTP encontrado! ${otp}`);
              return otp;
            }
          }
        }
        
        lastMessageCount = messages.length;
        
      } catch (error) {
        globalState.addLog('warn', '⚠️ Erro ao verificar mensagens, tentando novamente...');
      }
      
      // Espera 2s entre polls
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
    
    throw new Error(`⏰ Timeout aguardando OTP (${Math.round(timeoutMs/1000)}s)`);
  }

  /**
   * Fluxo completo: criar email → aguardar OTP
   */
  async createEmailAndWaitOTP(timeoutMs = 30000): Promise<{ email: string; md5: string; otp: string }> {
    const emailAccount = await this.createRandomEmail();
    globalState.addLog('info', `📧 Email criado: ${emailAccount.email}`);
    
    const otp = await this.waitForOTP(emailAccount.md5, timeoutMs);
    
    return {
      email: emailAccount.email,
      md5: emailAccount.md5,
      otp
    };
  }
}