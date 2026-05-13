import { chromium as chromiumExtra } from 'playwright-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import { Browser, Page, BrowserContext, Frame, devices } from 'playwright';
import { globalState } from '../state/globalState';
import { createEmailClient } from '../tempMail/client';
import { IEmailClient } from '../types/tempMail';
import { EmailProvider } from '../types';
import { gerarPayloadCompleto } from '../utils/dataGenerators';
import { ArtifactsManager } from '../utils/artifacts';
import * as accountStore from '../store/accountStore';
import {
  isSpeedMode, sp, randInt, randFloat,
  humanPause, cogPause,
  humanMouseMove, hoverElement, focusField, _typeChar,
  humanType, humanTypeForce, humanClick,
  clickForwardButton, scrollIdle, pageWarmup,
} from './humanActions';

chromiumExtra.use(StealthPlugin());

let browser: Browser | null = null;
let browserLaunching = false;
let currentLaunchProxy: string | null = null;

const contextosPorCiclo = new Map<number, BrowserContext>();

const CYCLE_TIMEOUT_MS = 10 * 60 * 1_000;
const MOBILE_DEVICE = devices['iPhone 14'];

// ─── Logger ───────────────────────────────────────────────────────────────────

function log(level: 'info' | 'warn' | 'success' | 'error', msg: string, cycle?: number): void {
  globalState.addLog(level, msg, cycle);
  const prefix = cycle !== undefined ? `[C#${cycle}]` : '[GLOBAL]';
  console.log(`${new Date().toISOString()} ${prefix} [${level.toUpperCase()}] ${msg}`);
}

// ─── Proxy helper ─────────────────────────────────────────────────────────────

function buildProxyServerArg(server: string): string {
  let normalized = server.trim();
  try {
    const parsed = new URL(
      normalized.startsWith('http://') || normalized.startsWith('https://')
        ? normalized
        : 'http://' + normalized
    );
    return `http://${parsed.host}`;
  } catch {
    normalized = normalized.replace(/^https:\/\//, 'http://');
    normalized = normalized.replace(/^http:\/\/[^@]+@/, 'http://');
    if (!normalized.startsWith('http://')) normalized = 'http://' + normalized;
    return normalized;
  }
}

// ─── Dispensar cookies ────────────────────────────────────────────────────────

async function dispensarCookies(p: Page): Promise<void> {
  const candidatos = [
    'button:has-text("Aceitar todos")',
    'button:has-text("Accept all")',
    'button:has-text("Aceitar")',
    'button:has-text("Accept")',
    '[id*="cookie"] button:has-text("Concordo")',
    '[class*="cookie"] button',
    '[class*="consent"] button',
    '[data-testid="cookie-banner-accept"]',
    '[data-testid="accept-cookies"]',
    '#onetrust-accept-btn-handler',
    '.onetrust-accept-btn-handler',
    'button#accept-recommended-btn-handler',
  ];
  for (const seletor of candidatos) {
    try {
      const el = p.locator(seletor).first();
      const visivel = await el.isVisible({ timeout: 1500 }).catch(() => false);
      if (visivel) {
        await hoverElement(p, seletor);
        await el.click({ timeout: 3000 });
        globalState.addLog('info', `🍪 Banner de cookies dispensado (${seletor})`);
        await humanPause(randInt(sp(300), sp(600)));
        return;
      }
    } catch { /* ignora */ }
  }
}

// ─── Aceitar termos ───────────────────────────────────────────────────────────

async function aceitarTermos(p: Page): Promise<void> {
  await humanPause(randInt(sp(500), sp(900)));
  const candidatos = [
    async () => {
      const el = p.locator('input[type="checkbox"]').first();
      await el.waitFor({ state: 'attached', timeout: 8000 });
      const box = await el.boundingBox().catch(() => null);
      if (box) {
        await humanMouseMove(p, box.x + box.width / 2, box.y + box.height / 2);
        await humanPause(randInt(sp(80), sp(160)));
      }
      await el.check({ force: true, timeout: 5000 });
    },
    async () => {
      const el = p.locator('label:has-text("Concordo"), [class*="label"]:has-text("Concordo")').first();
      await el.waitFor({ state: 'attached', timeout: 5000 });
      const box = await el.boundingBox().catch(() => null);
      if (box) await humanMouseMove(p, box.x + box.width / 2, box.y + box.height / 2);
      await humanPause(randInt(sp(60), sp(140)));
      await el.click({ force: true, timeout: 5000 });
    },
    async () => {
      const el = p.locator('[role="checkbox"]').first();
      await el.waitFor({ state: 'attached', timeout: 5000 });
      const box = await el.boundingBox().catch(() => null);
      if (box) await humanMouseMove(p, box.x + box.width / 2, box.y + box.height / 2);
      await humanPause(randInt(sp(60), sp(140)));
      await el.click({ force: true, timeout: 5000 });
    },
    async () => { await p.click('text=Concordo', { force: true, timeout: 5000 }); },
  ];
  let aceitou = false;
  for (const tentativa of candidatos) {
    try { await tentativa(); aceitou = true; break; } catch { /* tenta próximo */ }
  }
  if (!aceitou) throw new Error('Não foi possível aceitar os termos — nenhum seletor funcionou');
  globalState.addLog('info', '☑️ Termos aceitos');
}

// ─── Seleciona cidade ─────────────────────────────────────────────────────────

async function selecionarCidade(p: Page, cidade: string, cycle: number): Promise<void> {
  const INPUT_SEL = '[data-testid="flow-type-city-selector-v2-input"]';
  const DROPDOWN_ITEM_SELS = [
    '[data-testid="flow-type-city-selector-v2-option"]',
    '[role="option"]',
    '[role="listbox"] li',
    '[class*="suggestion"]',
    '[class*="option"]',
    '[class*="item"]',
  ];
  const norm = (s: string) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
  const nomeBusca = cidade.split(',')[0]!.trim();
  const nomeBuscaNorm = norm(nomeBusca);

  log('info', `📍 Digitando cidade: "${nomeBusca}"`, cycle);
  await p.waitForSelector(INPUT_SEL, { state: 'visible', timeout: 15000 });
  await focusField(p, INPUT_SEL);
  await p.fill(INPUT_SEL, '');
  await humanPause(randInt(sp(100), sp(200)));

  for (const ch of nomeBusca) {
    await _typeChar(p, ch, isSpeedMode());
    if (!isSpeedMode() && Math.random() < 0.08) await humanPause(randInt(80, 200));
  }

  log('info', '⏳ Aguardando dropdown de cidade...', cycle);
  let itemSel: string | null = null;
  const pollMs = isSpeedMode() ? 200 : 500;
  const fimDropdown = Date.now() + 8_000;
  while (Date.now() < fimDropdown) {
    for (const sel of DROPDOWN_ITEM_SELS) {
      try {
        const count = await p.locator(sel).count();
        if (count > 0) {
          const visivel = await p.locator(sel).first().isVisible({ timeout: 800 }).catch(() => false);
          if (visivel) { itemSel = sel; break; }
        }
      } catch { /* tenta próximo */ }
    }
    if (itemSel) break;
    await humanPause(pollMs);
  }

  if (!itemSel) {
    log('warn', '⚠️ Dropdown não detectado, tentando ArrowDown+Enter', cycle);
    await humanPause(randInt(sp(300), sp(600)));
    await p.keyboard.press('ArrowDown');
    await humanPause(randInt(sp(150), sp(300)));
    await p.keyboard.press('Enter');
    return;
  }

  await humanPause(randInt(sp(300), sp(600)));
  const opcoes = p.locator(itemSel);
  const total = await opcoes.count();
  log('info', `📍 Dropdown aberto com ${total} opções`, cycle);

  let clicou = false;
  for (let i = 0; i < total; i++) {
    try {
      const opcao = opcoes.nth(i);
      const texto = await opcao.innerText().catch(() => '');
      if (norm(texto).includes(nomeBuscaNorm)) {
        const opcaoBox = await opcao.boundingBox().catch(() => null);
        if (opcaoBox) {
          await humanMouseMove(
            p,
            opcaoBox.x + opcaoBox.width  * randFloat(0.25, 0.75),
            opcaoBox.y + opcaoBox.height * randFloat(0.25, 0.75)
          );
          await humanPause(randInt(sp(120), sp(280)));
        }
        await opcao.click({ timeout: 5000 });
        clicou = true;
        log('info', `📍 Cidade selecionada: "${texto.trim()}"`, cycle);
        break;
      }
    } catch { /* tenta próximo */ }
  }

  if (!clicou) {
    log('warn', '⚠️ Cidade não encontrada no dropdown, tentando ArrowDown+Enter', cycle);
    await p.keyboard.press('ArrowDown');
    await humanPause(randInt(sp(150), sp(300)));
    await p.keyboard.press('Enter');
  }
}

// ─── Browser management ───────────────────────────────────────────────────────

async function ensureBrowser(headless = false, proxyConfig?: string): Promise<void> {
  if (browser && browser.isConnected() && currentLaunchProxy === (proxyConfig ?? null)) return;
  if (browserLaunching) {
    while (browserLaunching) await new Promise<void>((r) => setTimeout(r, 100));
    if (browser && browser.isConnected() && currentLaunchProxy === (proxyConfig ?? null)) return;
  }
  browserLaunching = true;
  try {
    if (browser) { await browser.close().catch(() => {}); browser = null; }
    const launchOpts: any = {
      headless,
      args: [
        '--no-sandbox', '--disable-setuid-sandbox',
        '--disable-blink-features=AutomationControlled',
        '--disable-features=IsolateOrigins,site-per-process',
        '--window-size=390,844',
      ],
    };
    if (proxyConfig) {
      const proxyServer = buildProxyServerArg(proxyConfig);
      launchOpts.proxy = { server: proxyServer };
      const url = new URL(proxyConfig.startsWith('http') ? proxyConfig : 'http://' + proxyConfig);
      if (url.username) {
        launchOpts.proxy.username = decodeURIComponent(url.username);
        launchOpts.proxy.password = decodeURIComponent(url.password);
      }
    }
    browser = await (chromiumExtra as any).launch(launchOpts);
    currentLaunchProxy = proxyConfig ?? null;
    log('info', '🌐 Browser iniciado');
  } finally {
    browserLaunching = false;
  }
}

export async function closeBrowser(): Promise<void> {
  if (browser) { await browser.close().catch(() => {}); browser = null; }
}

// ─── Context por ciclo ────────────────────────────────────────────────────────

async function criarContextoCiclo(cycle: number, proxyConfig?: string): Promise<BrowserContext> {
  const ctx = await browser!.newContext({
    ...MOBILE_DEVICE,
    locale: 'pt-BR',
    timezoneId: 'America/Sao_Paulo',
    colorScheme: 'light',
    permissions: ['geolocation'],
    geolocation: { latitude: -23.55 + randFloat(-0.5, 0.5), longitude: -46.63 + randFloat(-0.5, 0.5) },
    userAgent: MOBILE_DEVICE.userAgent,
  });
  await ctx.route('**/*.{png,jpg,jpeg,gif,webp,svg,ico,woff,woff2,ttf,otf,eot}', (r) => r.abort()).catch(() => {});
  contextosPorCiclo.set(cycle, ctx);
  return ctx;
}

async function fecharContextoCiclo(cycle: number): Promise<void> {
  const ctx = contextosPorCiclo.get(cycle);
  if (ctx) {
    await ctx.close().catch(() => {});
    contextosPorCiclo.delete(cycle);
  }
}

// ─── Etapas do flow ───────────────────────────────────────────────────────────

async function etapa_digitarEmail(p: Page, email: string, cycle: number): Promise<void> {
  log('info', `📧 Digitando email: ${email}`, cycle);
  const SEL = '#PHONE_NUMBER_or_EMAIL_ADDRESS';
  await p.waitForSelector(SEL, { state: 'visible', timeout: 20000 });
  await humanTypeForce(p, SEL, email);
  log('info', '✅ Email digitado', cycle);
}

async function etapa_digitarSenha(p: Page, senha: string, cycle: number): Promise<void> {
  log('info', '🔑 Digitando senha...', cycle);
  const SEL = 'input[type="password"], #password, [name="password"]';
  await p.waitForSelector(SEL, { state: 'visible', timeout: 15000 });
  await humanTypeForce(p, SEL, senha);
  log('info', '✅ Senha digitada', cycle);
}

async function etapa_digitarNome(p: Page, nome: string, cycle: number): Promise<void> {
  log('info', `👤 Digitando nome: ${nome}`, cycle);
  const candidatos = [
    '[data-testid*="first-name"]',
    '[name="firstName"]',
    '[id*="first"]',
    'input[placeholder*="ome"]',
  ];
  for (const sel of candidatos) {
    const el = p.locator(sel).first();
    if (await el.isVisible({ timeout: 3000 }).catch(() => false)) {
      await humanTypeForce(p, sel, nome);
      log('info', '✅ Nome digitado', cycle);
      return;
    }
  }
  log('warn', '⚠️ Campo de nome não encontrado', cycle);
}

async function etapa_digitarSobrenome(p: Page, sobrenome: string, cycle: number): Promise<void> {
  log('info', `👤 Digitando sobrenome: ${sobrenome}`, cycle);
  const candidatos = [
    '[data-testid*="last-name"]',
    '[name="lastName"]',
    '[id*="last"]',
    'input[placeholder*="obrenome"]',
  ];
  for (const sel of candidatos) {
    const el = p.locator(sel).first();
    if (await el.isVisible({ timeout: 3000 }).catch(() => false)) {
      await humanTypeForce(p, sel, sobrenome);
      log('info', '✅ Sobrenome digitado', cycle);
      return;
    }
  }
  log('warn', '⚠️ Campo de sobrenome não encontrado', cycle);
}

async function etapa_aguardarOTP(
  p: Page,
  emailClient: IEmailClient,
  email: string,
  cycle: number,
  otpTimeoutMs = 120_000
): Promise<string> {
  log('info', '📨 Aguardando OTP no email...', cycle);
  const otp = await emailClient.waitForOTP(email, otpTimeoutMs, cycle);
  log('success', `✅ OTP recebido: ${otp}`, cycle);
  return otp;
}

async function etapa_digitarOTP(p: Page, otp: string, cycle: number): Promise<void> {
  log('info', `🔢 Digitando OTP: ${otp}`, cycle);
  const candidatos = [
    'input[name="otpCode"]',
    'input[autocomplete="one-time-code"]',
    '[data-testid*="otp"]',
    '[data-testid*="code"]',
    'input[inputmode="numeric"][maxlength="6"]',
    'input[inputmode="numeric"]',
  ];
  for (const sel of candidatos) {
    const el = p.locator(sel).first();
    if (await el.isVisible({ timeout: 5000 }).catch(() => false)) {
      await humanTypeForce(p, sel, otp);
      log('info', '✅ OTP digitado', cycle);
      return;
    }
  }
  // Fallback: campos de dígito único
  const singleDigitInputs = p.locator('input[maxlength="1"]');
  const count = await singleDigitInputs.count();
  if (count >= 4) {
    log('info', `🔢 Digitando OTP em ${count} campos individuais`, cycle);
    for (let i = 0; i < Math.min(count, otp.length); i++) {
      await focusField(p, `input[maxlength="1"]:nth-of-type(${i + 1})`);
      await _typeChar(p, otp[i]!, isSpeedMode());
      await humanPause(randInt(sp(80), sp(200)));
    }
    log('info', '✅ OTP digitado (campos individuais)', cycle);
    return;
  }
  throw new Error('Campo de OTP não encontrado');
}

// ─── _executarCiclo ───────────────────────────────────────────────────────────

async function _executarCiclo(
  cycle: number,
  opts: {
    cadastroUrl: string;
    emailProvider: EmailProvider;
    tempMailApiKey: string;
    otpTimeout: number;
    extraDelay: number;
    inviteCode: string;
  }
): Promise<void> {
  let page: Page | null = null;

  try {
    await criarContextoCiclo(cycle);
    const ctx = contextosPorCiclo.get(cycle)!;
    page = await ctx.newPage();
    page.setDefaultTimeout(30_000);

    // ⭐ 1. Criar email via provider ANTES de qualquer navegação
    //    Isso garante que o domínio do email pertence à conta do tempmailc
    //    e evita o erro 403 "domain_not_allowed".
    const emailClient: IEmailClient = createEmailClient(
      opts.emailProvider as any,
      opts.tempMailApiKey
    );
    const emailAccount = await emailClient.createRandomEmail();
    log('info', `📬 Email criado pelo provider: ${emailAccount.email}`, cycle);

    // ⭐ 2. Montar payload usando o email real do provider
    const payload = gerarPayloadCompleto(emailAccount, opts.inviteCode);

    log('info', `🌐 Navegando para ${opts.cadastroUrl}`, cycle);
    await page.goto(opts.cadastroUrl, { waitUntil: 'domcontentloaded', timeout: 45_000 });
    await humanPause(randInt(sp(800), sp(1800)));

    await dispensarCookies(page);

    // ⭐ 3. Aquecer página ANTES de qualquer interação com formulário
    await pageWarmup(page, cycle);

    // Etapa 1: email
    await etapa_digitarEmail(page, payload.email, cycle);
    await cogPause(400, 900);
    try { await aceitarTermos(page); } catch { /* não obrigatório nessa etapa */ }
    await clickForwardButton(page, cycle);
    await humanPause(randInt(sp(1200), sp(2500)));

    // Etapa 2: senha
    const senhaVisible = await page.locator('input[type="password"]').first()
      .isVisible({ timeout: 8000 }).catch(() => false);
    if (senhaVisible) {
      await etapa_digitarSenha(page, payload.senha, cycle);
      await cogPause(500, 1100);
      await clickForwardButton(page, cycle);
      await humanPause(randInt(sp(1200), sp(2500)));
    }

    // Etapa 3: nome e sobrenome
    const nomeVisible = await page.locator('[data-testid*="first-name"], [name="firstName"], [id*="first"]').first()
      .isVisible({ timeout: 8000 }).catch(() => false);
    if (nomeVisible) {
      await etapa_digitarNome(page, payload.nome, cycle);
      await humanPause(randInt(sp(300), sp(700)));
      await etapa_digitarSobrenome(page, payload.sobrenome, cycle);
      await cogPause(400, 900);
      const cidadeVisible = await page.locator('[data-testid="flow-type-city-selector-v2-input"]').first()
        .isVisible({ timeout: 3000 }).catch(() => false);
      if (cidadeVisible) await selecionarCidade(page, payload.cidade, cycle);
      await clickForwardButton(page, cycle);
      await humanPause(randInt(sp(1200), sp(2500)));
    }

    // Etapa 4: OTP
    const otpVisible = await page.locator(
      'input[autocomplete="one-time-code"], input[name="otpCode"], input[maxlength="1"]'
    ).first().isVisible({ timeout: 12000 }).catch(() => false);

    if (otpVisible) {
      const otp = await etapa_aguardarOTP(page, emailClient, payload.email, cycle, opts.otpTimeout);
      await etapa_digitarOTP(page, otp, cycle);
      await cogPause(400, 900);
      await clickForwardButton(page, cycle);
      await humanPause(randInt(sp(1500), sp(3000)));
    }

    // ✔️ Verifica sucesso
    const url = page.url();
    const sucesso = url.includes('myaccount') || url.includes('home') || url.includes('dashboard');
    if (sucesso) {
      log('success', `🎉 Conta criada com sucesso! URL: ${url}`, cycle);
      accountStore.save({
        cycle,
        provider: opts.emailProvider,
        nome: payload.nome,
        sobrenome: payload.sobrenome,
        email: payload.email,
        telefone: payload.telefone,
        senha: payload.senha,
        localizacao: payload.localizacao,
        codigoIndicacao: payload.codigoIndicacao,
        cookies: [],
      });
      await ArtifactsManager.saveErrorArtifacts(page, cycle);
    } else {
      log('warn', `⚠️ Flow concluído mas URL inesperada: ${url}`, cycle);
    }

  } catch (err: any) {
    log('error', `❌ Erro no ciclo: ${err?.message ?? err}`, cycle);
    if (page) await ArtifactsManager.saveErrorArtifacts(page, cycle).catch(() => {});
    throw err;
  } finally {
    await fecharContextoCiclo(cycle);
  }
}

// ─── Classe MockPlaywrightFlow ────────────────────────────────────────────────

type FlowOpts = {
  emailProvider: EmailProvider;
  tempMailApiKey: string;
  otpTimeout: number;
  extraDelay: number;
  inviteCode: string;
};

export class MockPlaywrightFlow {
  private static headless = false;

  static async init(headless = false): Promise<void> {
    MockPlaywrightFlow.headless = headless;
    await ensureBrowser(headless);
  }

  static async execute(
    cadastroUrl: string,
    opts: FlowOpts,
    cycle: number
  ): Promise<void> {
    const timeoutHandle = setTimeout(() => {
      log('error', `⏰ Ciclo ${cycle} excedeu timeout de ${CYCLE_TIMEOUT_MS / 1000}s`, cycle);
      fecharContextoCiclo(cycle).catch(() => {});
    }, CYCLE_TIMEOUT_MS);
    try {
      await _executarCiclo(cycle, { cadastroUrl, ...opts });
    } finally {
      clearTimeout(timeoutHandle);
    }
  }

  static async cleanup(): Promise<void> {
    await closeBrowser();
  }
}

// ─── Executor legado ──────────────────────────────────────────────────────────

export async function executarMockFlow(
  cycle: number,
  proxyConfig?: string,
  emailProvider?: EmailProvider
): Promise<void> {
  const state = globalState.getState();
  const config = state.config;
  await ensureBrowser(config.headless ?? false, proxyConfig);
  await _executarCiclo(cycle, {
    cadastroUrl: (config as any).cadastroUrl ?? 'https://www.booking.com/register.html?lang=pt-br',
    emailProvider: emailProvider ?? config.emailProvider,
    tempMailApiKey: config.tempMailApiKey ?? '',
    otpTimeout: config.otpTimeout ?? 120_000,
    extraDelay: config.extraDelay ?? 0,
    inviteCode: config.inviteCode ?? '',
  });
}
