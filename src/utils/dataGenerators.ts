import { EmailAccount } from '../types/tempMail';

export interface RegistrationPayload {
  email: string;
  telefone: string;
  senha: string;
  nome: string;
  sobrenome: string;
  localizacao: string;
  codigoIndicacao: string;
}

const NOMES_MASCULINOS = [
  'João', 'Pedro', 'Lucas', 'Mateus', 'Gabriel', 'Rafael', 'Guilherme',
  'Samuel', 'Enzo', 'Ryan', 'Arthur', 'Davi', 'Heitor', 'Henrique',
  'Bernardo', 'Theo', 'Murilo', 'Enrico', 'Lorenzo', 'Bento', 'Yuri',
  'Gael', 'Otávio', 'Vicente', 'Benjamim', 'Thomas', 'Noah', 'Eduardo',
  'Felipe', 'Daniel', 'Ricardo',
];

const SOBRENOMES = [
  'Silva', 'Santos', 'Oliveira', 'Souza', 'Rodrigues', 'Ferreira', 'Alves',
  'Pereira', 'Lima', 'Gomes', 'Costa', 'Ribeiro', 'Martins', 'Carvalho',
  'Almeida', 'Lopes', 'Sousa', 'Fernandes', 'Gonçalves', 'Vieira',
  'Campos', 'Marques', 'Mendes', 'Barbosa', 'Rocha', 'Dias', 'Jorge',
  'Morais', 'Nunes', 'Cardoso',
];

// DDDs válidos do Brasil (ANATEL)
const DDDS = [
  '11', '12', '13', '14', '15', '16', '17', '18', '19',
  '21', '22', '24',
  '27', '28',
  '31', '32', '33', '34', '35', '37', '38',
  '41', '42', '43', '44', '45', '46',
  '47', '48', '49',
  '51', '53', '54', '55',
  '61', '62', '63', '64', '65', '66', '67', '68', '69',
  '71', '73', '74', '75', '77',
  '79',
  '81', '82', '83', '84', '85', '86', '87', '88', '89',
  '91', '92', '93', '94', '95', '96', '97', '98', '99',
];

const rand = <T>(arr: T[]): T => arr[Math.floor(Math.random() * arr.length)]!;

/**
 * Gera um número de celular brasileiro válido.
 * Formato retornado: só dígitos, sem máscara — ex: "11987654321"
 */
export function gerarTelefone(): string {
  const ddd = rand(DDDS);
  const sufixo = Math.floor(10000000 + Math.random() * 90000000).toString();
  return `${ddd}9${sufixo}`;
}

export function gerarTelefoneFormatado(): string {
  const raw = gerarTelefone();
  const ddd = raw.substring(0, 2);
  const parte1 = raw.substring(2, 7);
  const parte2 = raw.substring(7);
  return `(${ddd}) ${parte1}-${parte2}`;
}

/** @deprecated Use gerarTelefone() */
export function gerarTelefoneFixo(): string { return gerarTelefone(); }

export function gerarNome(): string { return rand(NOMES_MASCULINOS); }
export function gerarSobrenome(): string { return rand(SOBRENOMES); }

/**
 * Gera o payload completo para um ciclo de cadastro.
 * @param emailAccount - conta de email temporário criada
 * @param inviteCode   - código de indicação vindo da config do painel
 */
export function gerarPayloadCompleto(
  emailAccount?: EmailAccount,
  inviteCode?: string
): RegistrationPayload {
  return {
    email: emailAccount?.email ?? `test${Math.floor(Math.random() * 10000)}@tempmail.lol`,
    telefone: gerarTelefone(),
    senha: 'connect@10',
    nome: gerarNome(),
    sobrenome: gerarSobrenome(),
    localizacao: 'Itajubá, MG, Brasil',
    codigoIndicacao: inviteCode ?? '',
  };
}

export function gerarPayloads(qtd = 5): RegistrationPayload[] {
  return Array.from({ length: qtd }, () => gerarPayloadCompleto());
}
