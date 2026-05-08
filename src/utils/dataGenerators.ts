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

/**
 * Nomes masculinos comuns no Brasil
 */
const NOMES_MASCULINOS = [
  'João', 'Pedro', 'Lucas', 'Mateus', 'Gabriel', 'Rafael', 'Guilherme', 
  'Samuel', 'Enzo', 'Ryan', 'Arthur', 'Davi', 'Heitor', 'Henrique', 
  'Bernardo', 'Theo', 'Murilo', 'Enrico', 'Lorenzo', 'Bento', 'Yuri', 
  'Gael', 'Otávio', 'Vicente', 'Benjamim', 'Thomas', 'Noah', 'Eduardo',
  'Felipe', 'Daniel', 'Ricardo'
];

/**
 * Sobrenomes comuns no Brasil
 */
const SOBRENOMES = [
  'Silva', 'Santos', 'Oliveira', 'Souza', 'Rodrigues', 'Ferreira', 'Alves',
  'Pereira', 'Lima', 'Gomes', 'Costa', 'Ribeiro', 'Martins', 'Carvalho',
  'Almeida', 'Lopes', 'Sousa', 'Fernandes', 'Gonçalves', 'Vieira',
  'Campos', 'Marques', 'Mendes', 'Barbosa', 'Rocha', 'Dias', 'Jorge',
  'Morais', 'Nunes', 'Cardoso'
];

/**
 * Gera telefone fixo brasileiro aleatório (DDD + 8 dígitos)
 * Formato: (DD) XXXX-XXXX
 */
export function gerarTelefoneFixo(): string {
  const ddds = [
    '12', '11', '13', '14', '15', '16', '17', '18', '19', // SP
    '21', '22', '24', // RJ
    '31', '32', '33', '34', '35', '37', '38', // MG
    '41', '42', '43', '44', '45', '46', // PR
    '47', '48', '49', // SC
    '51', '53', '54', '55' // RS
  ];
  
  const ddd = ddds[Math.floor(Math.random() * ddds.length)];
  const numero = Math.floor(10000000 + Math.random() * 90000000);
  
  return `(${ddd}) ${numero.toString().substring(0, 4)}-${numero.toString().substring(4)}`;
}

/**
 * Nome masculino aleatório
 */
export function gerarNome(): string {
  return NOMES_MASCULINOS[Math.floor(Math.random() * NOMES_MASCULINOS.length)]!;
}

/**
 * Sobrenome aleatório
 */
export function gerarSobrenome(): string {
  return SOBRENOMES[Math.floor(Math.random() * SOBRENOMES.length)]!;
}

/**
 * Payload completo de cadastro
 */
export function gerarPayloadCompleto(emailAccount?: EmailAccount): RegistrationPayload {
  const email = emailAccount?.email || `test${Math.floor(Math.random() * 10000)}@tempmail.lol`;
  
  return {
    email,
    telefone: gerarTelefoneFixo(),
    senha: 'connect@10', // Fixa conforme especificado
    nome: gerarNome(),
    sobrenome: gerarSobrenome(),
    localizacao: 'Itajubá, MG, Brasil',
    codigoIndicacao: 'gkd2n7c' // Fixo conforme especificado
  };
}

/**
 * Debug: gera múltiplos payloads
 */
export function gerarPayloads(qtd: number = 5): RegistrationPayload[] {
  return Array.from({ length: qtd }, () => gerarPayloadCompleto());
}