import { globalState } from '../state/globalState';
import { MailMessage } from '../types/tempMail';
import { LogEntry } from '../types';

export class OTPParser {
  /**
   * Extrai OTP de 4 dígitos de HTML/email
   * Ignora: datas, telefones, códigos longos, etc.
   */
  static extractOTP(html: string): string | null {
    // Regex para 4 dígitos isolados (com espaços/pontos opcionais)
    const otpRegex = /(?:code|otp|código|verificação)\s*[:\-]?\s*(\d{4})(?!\d)|(\b\d{4}\b)(?=\s*(?:is|é|your|seu|code|otp|código))/gi;
    
    const matches = html.match(otpRegex);
    if (matches) {
      const otp = matches[0].replace(/\D/g, ''); // Remove não-dígitos
      if (otp.length === 4) {
        globalState.addLog('success', `🔢 OTP extraído: ${otp}`);
        return otp;
      }
    }

    // Fallback: qualquer 4 dígitos isolados
    const fallbackRegex = /\b(\d{4})\b(?!\d)/g;
    const fallback = html.match(fallbackRegex)?.[0];
    if (fallback) {
      globalState.addLog('info', `🔢 OTP fallback: ${fallback}`);
      return fallback;
    }

    return null;
  }

  /**
   * Extrai OTP de mensagem completa do Temp-Mail
   */
  static extractFromMessage(message: MailMessage): string | null {
    // Tenta HTML primeiro
    if (message.mail_html) {
      const otp = this.extractOTP(message.mail_html);
      if (otp) return otp;
    }
    
    // Tenta texto plano
    if (message.mail_text) {
      const otp = this.extractOTP(message.mail_text);
      if (otp) return otp;
    }
    
    // Tenta preview
    if (message.mail_preview) {
      const otp = this.extractOTP(message.mail_preview);
      if (otp) return otp;
    }

    globalState.addLog('warn', '⚠️ OTP não encontrado no email');
    return null;
  }

  /**
   * Debug: mostra trechos relevantes do HTML
   */
  static debugHTML(html: string): string[] {
    const snippets: string[] = [];
    
    // Procura por códigos próximos
    const codePatterns = [
      /code|otp|código|verificação|verification/i,
      /\d{4}/g,
      /[:\-]\s*\d{4}/g
    ];
    
    codePatterns.forEach(pattern => {
      const matches = html.match(pattern);
      if (matches) {
        snippets.push(...matches.slice(0, 3)); // Primeiros 3
      }
    });
    
    return [...new Set(snippets)].slice(0, 5);
  }
}