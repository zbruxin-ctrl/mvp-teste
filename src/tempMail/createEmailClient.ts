/**
 * createEmailClient.ts
 * Factory que instancia o cliente de email correto com base no provider selecionado.
 * Separado de client.ts para evitar import circular com mockFlow.
 */

import { IEmailClient } from '../types/tempMail';
import {
  TempMailClient,
  MailTmClient,
  YOPmailClient,
  TempMailCClient,
} from './client';

export type SupportedProvider = 'temp-mail.io' | 'mail.tm' | 'yopmail' | 'tempmailc';

/**
 * Instancia o cliente correto para o provider informado.
 * @param provider  Identificador do provider
 * @param apiKey    Chave de API (usada por temp-mail.io e tempmailc; ignorada pelos demais)
 */
export function createEmailClient(
  provider: SupportedProvider | string,
  apiKey = ''
): IEmailClient {
  switch (provider) {
    case 'temp-mail.io':
      return new TempMailClient(apiKey);
    case 'mail.tm':
      return new MailTmClient();
    case 'yopmail':
      return new YOPmailClient();
    case 'tempmailc':
      return new TempMailCClient(apiKey);
    default:
      // Fallback: usa tempmailc se a chave estiver presente, mail.tm caso contrário
      if (apiKey) return new TempMailCClient(apiKey);
      return new MailTmClient();
  }
}
