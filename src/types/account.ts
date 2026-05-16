import type { Cookie } from 'playwright';

export interface Account {
  id: string;
  cycle: number;
  provider: string;
  nome: string;
  sobrenome: string;
  email: string;
  telefone: string;
  senha: string;
  /** @deprecated use `senha` — mantido para compatibilidade com saves antigos */
  password?: string;
  localizacao: string;
  codigoIndicacao: string;
  cookies: Cookie[];
  createdAt: string;
}
