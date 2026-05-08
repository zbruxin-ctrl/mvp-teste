import { globalState } from '../state/globalState';
import { MailMessage } from '../types/tempMail';

export class OTPParser {
  static extractOTP(html: string): string | null {
    // Tenta padrão "code: XXXX" ou "OTP XXXX"
    const primary = html.match(/(?:code|otp|c[oó]digo|verifica[cç][aã]o)[\s:\-]*([0-9]{4,8})/i);
    if (primary) {
      globalState.addLog('success', `🔢 OTP extraído: ${primary[1]}`);
      return primary[1]!;
    }

    // Fallback: qualquer sequência de 4-8 dígitos isolada
    const fallback = html.match(/\b([0-9]{4,8})\b/);
    if (fallback) {
      globalState.addLog('info', `🔢 OTP fallback: ${fallback[1]}`);
      return fallback[1]!;
    }

    return null;
  }

  static extractFromMessage(message: MailMessage): string | null {
    if (message.mail_html) {
      const otp = this.extractOTP(message.mail_html);
      if (otp) return otp;
    }
    if (message.mail_text) {
      const otp = this.extractOTP(message.mail_text);
      if (otp) return otp;
    }
    if (message.mail_preview) {
      const otp = this.extractOTP(message.mail_preview);
      if (otp) return otp;
    }
    globalState.addLog('warn', '⚠️ OTP não encontrado no email');
    return null;
  }
}
