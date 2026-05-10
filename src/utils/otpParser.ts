import { globalState } from '../state/globalState';
import { MailMessage } from '../types/tempMail';

export class OTPParser {
  static extractOTP(text: string): string | null {
    // 1) Remove tags HTML — junta primeiro sem quebras para não quebrar tags multiline
    const noBreaks = text.replace(/\r?\n/g, ' ').replace(/\t/g, ' ');
    const clean = noBreaks
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/gi, ' ')
      .replace(/&#[0-9]+;/g, ' ')
      .replace(/&[a-z]+;/gi, ' ')
      .replace(/\s+/g, ' ')
      .trim();

    // 2) Padrão primário: palavra-chave de verificação seguida do código
    //    Aceita: "código", "code", "otp", "verif*", "confirma*", "pin"
    const primary = clean.match(
      /(?:c[oó]digo|code|otp|pin|verif[a-z]*|confirma[a-z]*)[^0-9]{0,60}([0-9]{4,8})/i
    );
    if (primary?.[1]) {
      globalState.addLog('success', `🔢 OTP extraído (primary): ${primary[1]}`);
      return primary[1];
    }

    // 3) Padrão secundário: número isolado por espaços/pontuação — mas apenas se
    //    não estiver colado a outros dígitos (evita pegar anos, IDs longos, etc.)
    //    Exige que o número tenha exatamente 4–6 dígitos (OTPs do Uber são 4 dígitos)
    const isolated = clean.match(/(?:^|[^0-9])([0-9]{4,6})(?:[^0-9]|$)/);
    if (isolated?.[1]) {
      // Filtra falsos positivos comuns: anos (19xx/20xx), CEPs (não se aplicam ao Uber)
      const num = isolated[1];
      const isYear = /^(19|20)[0-9]{2}$/.test(num);
      if (!isYear) {
        globalState.addLog('info', `🔢 OTP extraído (isolated): ${num}`);
        return num;
      }
    }

    // 4) Fallback mais restrito: busca o primeiro bloco de 4 dígitos que não seja ano
    const allNums = [...clean.matchAll(/(?:^|[^0-9])([0-9]{4,6})(?:[^0-9]|$)/g)];
    for (const m of allNums) {
      const num = m[1]!;
      if (!/^(19|20)[0-9]{2}$/.test(num)) {
        globalState.addLog('info', `🔢 OTP fallback: ${num}`);
        return num;
      }
    }

    return null;
  }

  static extractFromMessage(message: MailMessage): string | null {
    // Tenta mail_html primeiro (mais rico), depois text, depois preview
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

    globalState.addLog('warn', `⚠️ OTP não encontrado no email (subject: "${message.mail_subject}")`);
    return null;
  }
}
