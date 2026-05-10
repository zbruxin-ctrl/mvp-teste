import { globalState } from '../state/globalState';
import { MailMessage } from '../types/tempMail';

export class OTPParser {
  static extractOTP(text: string): string | null {
    // Remove tags HTML para limpar o body_html antes de processar
    const clean = text.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ');

    // Padrao 1: "Código de confirmação: 1935" ou com quebra de linha entre eles
    const primary = clean.match(
      /(?:c[oó]digo|code|otp|verif[a-z]*|confirma[a-z]*)[^0-9]{0,40}([0-9]{4,8})/i
    );
    if (primary) {
      globalState.addLog('success', `🔢 OTP extraído (primary): ${primary[1]}`);
      return primary[1]!;
    }

    // FIX: adicionada flag /m (multiline) para que ^ e $ batam em cada linha
    // do texto, não apenas no início/fim da string inteira.
    // Sem /m, o padrão falhava silenciosamente em todos os emails com múltiplas linhas.
    const isolated = clean.match(/(?:^|\s)([0-9]{4,8})(?:\s|$)/m);
    if (isolated) {
      globalState.addLog('info', `🔢 OTP extraído (isolated): ${isolated[1]}`);
      return isolated[1]!;
    }

    // Fallback: qualquer sequencia de 4-8 digitos
    const fallback = clean.match(/\b([0-9]{4,8})\b/);
    if (fallback) {
      globalState.addLog('info', `🔢 OTP fallback: ${fallback[1]}`);
      return fallback[1]!;
    }

    return null;
  }

  static extractFromMessage(message: MailMessage): string | null {
    // Tenta body_html primeiro (mais rico), depois text, depois preview
    const sources = [
      message.mail_html,
      message.mail_text,
      message.mail_preview,
    ];

    for (const src of sources) {
      if (src && src.trim().length > 0) {
        const otp = this.extractOTP(src);
        if (otp) return otp;
      }
    }

    globalState.addLog('warn', '⚠️ OTP não encontrado no email');
    return null;
  }
}
