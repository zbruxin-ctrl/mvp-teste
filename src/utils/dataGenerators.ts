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

const rand = <T>(arr: T[]): T => arr[Math.floor(Math.random() * arr.length)]!;

export function gerarTelefoneFixo(): string {
  const ddds = [
    '11', '12', '13', '14', '15', '16', '17', '18', '19',
    '21', '22', '24',
    '31', '32', '33', '34', '35', '37', '38',
    '41', '42', '43', '44', '45', '46',
    '47', '48', '49',
    '51', '53', '54', '55',
  ];
  const ddd = rand(ddds);
  const numero = Math.floor(10000000 + Math.random() * 90000000).toString();
  return `(${ddd}) ${numero.substring(0, 4)}-${numero.substring(4)}`;
}

export function gerarNome(): string { return rand(NOMES_MASCULINOS); }
export function gerarSobrenome(): string { return rand(SOBRENOMES); }

export function gerarPayloadCompleto(emailAccount?: EmailAccount): RegistrationPayload {
  return {
    email: emailAccount?.email ?? `test${Math.floor(Math.random() * 10000)}@tempmail.lol`,
    telefone: gerarTelefoneFixo(),
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
