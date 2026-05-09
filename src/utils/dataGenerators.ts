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
 *
 * Formato retornado: só dígitos, sem máscara — ex: "11987654321"
 * (DDD 2 dígitos + 9 + 8 dígitos aleatórios)
 *
 * Caso precise do formato com máscara, use gerarTelefoneFormatado().
 */
export function gerarTelefone(): string {
  const ddd = rand(DDDS);
  // 8 dígitos finais: 10000000–99999999 garante sempre 8 dígitos
  const sufixo = Math.floor(10000000 + Math.random() * 90000000).toString();
  // Celular brasileiro: DDD + 9 (dígito fixo) + 8 dígitos
  return `${ddd}9${sufixo}`;
}

/**
 * Mesma lógica, mas no formato visual: (11) 98765-4321
 * Útil para exibir nos logs.
 */
export function gerarTelefoneFormatado(): string {
  const raw = gerarTelefone(); // ex: "11987654321" (11 dígitos)
  const ddd = raw.substring(0, 2);
  const parte1 = raw.substring(2, 7);  // 5 dígitos: 9XXXX
  const parte2 = raw.substring(7);     // 4 dígitos
  return `(${ddd}) ${parte1}-${parte2}`;
}

/** @deprecated Use gerarTelefone() — esta função gerava fixo de 8 dígitos (inválido) */
export function gerarTelefoneFixo(): string { return gerarTelefone(); }

export function gerarNome(): string { return rand(NOMES_MASCULINOS); }
export function gerarSobrenome(): string { return rand(SOBRENOMES); }

export function gerarPayloadCompleto(emailAccount?: EmailAccount): RegistrationPayload {
  return {
    email: emailAccount?.email ?? `test${Math.floor(Math.random() * 10000)}@tempmail.lol`,
    telefone: gerarTelefone(),   // só dígitos — o campo da Uber aceita direto
    senha: 'connect@10',
    nome: gerarNome(),
    sobrenome: gerarSobrenome(),
    localizacao: 'Itajubá, MG, Brasil',
    codigoIndicacao: 'gkd2n7c',
  };
}

export function gerarPayloads(qtd = 5): RegistrationPayload[] {
  return Array.from({ length: qtd }, () => gerarPayloadCompleto());
}
