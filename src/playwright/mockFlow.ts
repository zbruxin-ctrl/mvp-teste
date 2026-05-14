import { chromium as chromiumExtra } from 'playwright-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import { Browser, Page, BrowserContext, devices } from 'playwright';
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

const contextosPorCiclo = new Map<number, import('playwright').BrowserContext>();

const CYCLE_TIMEOUT_MS = 10 * 60 * 1_000;
const MOBILE_DEVICE = devices['iPhone 14'];

// ─── Detecção de URL ──────────────────────────────────────────────────────────

/**
 * Sucesso REAL = saiu de auth.uber.com e chegou num destino Uber final.
 * bonjour.uber.com/hub é a tela do hub de KYC — ainda não é sucesso final,
 * mas é onde salvamos a conta (cadastro concluído, KYC pendente é normal).
 */
function isSuccessUrl(url: string): boolean {
  return (
    url.includes('bonjour.uber.com/hub') ||
    url.includes('bonjour.uber.com/step') ||
    url.includes('rider.uber.com') ||
    (url.includes('m.uber.com') && !url.includes('auth.uber.com')) ||
    url.includes('uber.com/go') ||
    url.includes('uber.com/home') ||
    url.includes('uber.com/feed') ||
    url.includes('/account') ||
    url.includes('/profile') ||
    url.includes('/dashboard') ||
    url.includes('/home')
  );
}

/** Ainda dentro do funil de cadastro/auth do Uber. */
function isOnboardingUrl(url: string): boolean {
  return (
    url.includes('auth.uber.com') ||
    url.includes('/signup') ||
    url.includes('/register') ||
    url.includes('/onboard') ||
    url.includes('/verify') ||
    url.includes('/confirm')
  );
}

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
        ? normalized : 'http://' + normalized
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
    'button:has-text("Aceitar todos")', 'button:has-text("Accept all")',
    'button:has-text("Aceitar")', 'button:has-text("Accept")',
    '[id*="cookie"] button:has-text("Concordo")',
    '[class*="cookie"] button', '[class*="consent"] button',
    '[data-testid="cookie-banner-accept"]', '[data-testid="accept-cookies"]',
    '#onetrust-accept-btn-handler', '.onetrust-accept-btn-handler',
    'button#accept-recommended-btn-handler',
  ];
  for (const seletor of candidatos) {
    try {
      const el = p.locator(seletor).first();
      if (await el.isVisible({ timeout: 1500 }).catch(() => false)) {
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

async function tentarAceitarTermos(p: Page): Promise<boolean> {
  const candidatos: Array<() => Promise<void>> = [
    async () => {
      const el = p.locator('input[type="checkbox"]').first();
      await el.waitFor({ state: 'attached', timeout: 4000 });
      if (!await el.isVisible({ timeout: 2000 }).catch(() => false)) throw new Error('not visible');
      const box = await el.boundingBox().catch(() => null);
      if (box) await humanMouseMove(p, box.x + box.width / 2, box.y + box.height / 2);
      await humanPause(randInt(sp(80), sp(160)));
      await el.check({ force: true, timeout: 5000 });
    },
    async () => {
      const el = p.locator('[role="checkbox"]').first();
      await el.waitFor({ state: 'attached', timeout: 4000 });
      if (!await el.isVisible({ timeout: 2000 }).catch(() => false)) throw new Error('not visible');
      const box = await el.boundingBox().catch(() => null);
      if (box) await humanMouseMove(p, box.x + box.width / 2, box.y + box.height / 2);
      await humanPause(randInt(sp(60), sp(140)));
      await el.click({ force: true, timeout: 5000 });
    },
    async () => {
      const el = p.locator('label:has-text("Concordo"), label:has-text("Agree"), label:has-text("aceito"), label:has-text("accept")').first();
      await el.waitFor({ state: 'attached', timeout: 4000 });
      const box = await el.boundingBox().catch(() => null);
      if (box) await humanMouseMove(p, box.x + box.width / 2, box.y + box.height / 2);
      await humanPause(randInt(sp(60), sp(140)));
      await el.click({ force: true, timeout: 5000 });
    },
  ];
  for (const fn of candidatos) {
    try { await fn(); globalState.addLog('info', '☑️ Termos aceitos'); return true; } catch { /* tenta próximo */ }
  }
  return false;
}

// ─── Seleciona cidade ─────────────────────────────────────────────────────────

async function selecionarCidade(p: Page, cidade: string, cycle: number): Promise<void> {
  const INPUT_SEL = '[data-testid="flow-type-city-selector-v2-input"]';
  const DROPDOWN_ITEM_SELS = [
    '[data-testid="flow-type-city-selector-v2-option"]',
    '[role="option"]', '[role="listbox"] li',
    '[class*="suggestion"]', '[class*="option"]', '[class*="item"]',
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

  let itemSel: string | null = null;
  const pollMs = isSpeedMode() ? 200 : 500;
  const fimDropdown = Date.now() + 8_000;
  while (Date.now() < fimDropdown) {
    for (const sel of DROPDOWN_ITEM_SELS) {
      try {
        if (await p.locator(sel).count() > 0 &&
            await p.locator(sel).first().isVisible({ timeout: 800 }).catch(() => false)) {
          itemSel = sel; break;
        }
      } catch { /* continua */ }
    }
    if (itemSel) break;
    await humanPause(pollMs);
  }

  if (!itemSel) {
    log('warn', '⚠️ Dropdown não detectado, tentando ArrowDown+Enter', cycle);
    await p.keyboard.press('ArrowDown');
    await humanPause(randInt(sp(150), sp(300)));
    await p.keyboard.press('Enter');
    return;
  }

  await humanPause(randInt(sp(300), sp(600)));
  const opcoes = p.locator(itemSel);
  const total = await opcoes.count();
  let clicou = false;
  for (let i = 0; i < total; i++) {
    try {
      const opcao = opcoes.nth(i);
      const texto = await opcao.innerText().catch(() => '');
      if (norm(texto).includes(nomeBuscaNorm)) {
        const box = await opcao.boundingBox().catch(() => null);
        if (box) await humanMouseMove(p, box.x + box.width * randFloat(0.25, 0.75), box.y + box.height * randFloat(0.25, 0.75));
        await humanPause(randInt(sp(120), sp(280)));
        await opcao.click({ timeout: 5000 });
        clicou = true;
        log('info', `📍 Cidade selecionada: "${texto.trim()}"`, cycle);
        break;
      }
    } catch { /* continua */ }
  }
  if (!clicou) {
    await p.keyboard.press('ArrowDown');
    await humanPause(randInt(sp(150), sp(300)));
    await p.keyboard.press('Enter');
  }
}

// ─── Tela WhatsApp opt-in ─────────────────────────────────────────────────────

/**
 * Detecta a tela "Fale com a Uber pelo WhatsApp" (data-testid="step whatsAppOptIn")
 * e clica em NÃO ATIVAR.
 * Retorna true se a tela estava presente e foi tratada.
 */
async function tratarTelaWhatsApp(p: Page, cycle: number): Promise<boolean> {
  const isWhatsApp =
    await p.locator('[data-testid="step whatsAppOptIn"]').isVisible({ timeout: 3000 }).catch(() => false);
  if (!isWhatsApp) return false;

  log('info', '💬 Tela WhatsApp opt-in detectada — clicando NÃO ATIVAR', cycle);
  await cogPause(400, 900);

  // Botão "NÃO ATIVAR" pelo texto (Playwright locator by text)
  const btn = p.locator('button', { hasText: /NÃO ATIVAR/i }).first();
  if (await btn.isVisible({ timeout: 3000 }).catch(() => false)) {
    const box = await btn.boundingBox().catch(() => null);
    if (box) await humanMouseMove(p, box.x + box.width * randFloat(0.3, 0.7), box.y + box.height * randFloat(0.3, 0.7));
    await humanPause(randInt(sp(120), sp(280)));
    await btn.click({ timeout: 5000 });
    log('info', '✅ WhatsApp opt-in recusado', cycle);
    await humanPause(randInt(sp(600), sp(1200)));
    return true;
  }

  // Fallback pelo testId do rodapé de navegação
  const nav = p.locator('[data-testid="step-bottom-navigation"] button').first();
  if (await nav.isVisible({ timeout: 2000 }).catch(() => false)) {
    await nav.click({ timeout: 5000 });
    log('info', '✅ WhatsApp opt-in recusado (fallback nav)', cycle);
    await humanPause(randInt(sp(600), sp(1200)));
    return true;
  }

  return false;
}

// ─── Hub de KYC — clicar em "Foto do perfil" ─────────────────────────────────

/**
 * Detecta a tela do hub (data-testid="hub") e clica no item "Foto do perfil"
 * (data-testid="stepItem profilePhoto").
 * Retorna true se estava no hub e navegou para a etapa de foto.
 */
async function tratarHubKYC(p: Page, cycle: number): Promise<boolean> {
  const isHub =
    await p.locator('[data-testid="hub"]').isVisible({ timeout: 3000 }).catch(() => false);
  if (!isHub) return false;

  log('info', '🏠 Hub KYC detectado — clicando em Foto do perfil', cycle);
  await cogPause(500, 1000);

  const fotoItem = p.locator('[data-testid="stepItem profilePhoto"]').first();
  if (await fotoItem.isVisible({ timeout: 5000 }).catch(() => false)) {
    const box = await fotoItem.boundingBox().catch(() => null);
    if (box) await humanMouseMove(p, box.x + box.width * randFloat(0.2, 0.8), box.y + box.height * randFloat(0.2, 0.8));
    await humanPause(randInt(sp(200), sp(400)));
    await fotoItem.click({ timeout: 5000 });
    log('info', '📸 Navegando para etapa de foto do perfil', cycle);
    await humanPause(randInt(sp(800), sp(1500)));
    return true;
  }

  log('warn', '⚠️ Item "Foto do perfil" não encontrado no hub', cycle);
  return false;
}

// ─── Tela de foto do perfil — clicar "Tirar foto" ────────────────────────────

/**
 * Detecta a tela "Tire sua foto do perfil" (data-testid="step profilePhoto")
 * e clica no botão "Tirar foto" (data-testid="docUploadButton").
 * Retorna true se tratou a tela.
 */
async function tratarTelaFotoPerfil(p: Page, cycle: number): Promise<boolean> {
  const isFotoStep =
    await p.locator('[data-testid="step profilePhoto"]').isVisible({ timeout: 3000 }).catch(() => false);
  if (!isFotoStep) return false;

  log('info', '📷 Tela de foto do perfil detectada — clicando Tirar foto', cycle);
  await cogPause(600, 1200);

  // Botão principal pelo testId
  const btnFoto = p.locator('[data-testid="docUploadButton"]').first();
  if (await btnFoto.isVisible({ timeout: 5000 }).catch(() => false)) {
    const box = await btnFoto.boundingBox().catch(() => null);
    if (box) await humanMouseMove(p, box.x + box.width * randFloat(0.3, 0.7), box.y + box.height * randFloat(0.3, 0.7));
    await humanPause(randInt(sp(200), sp(450)));
    await btnFoto.click({ timeout: 5000 });
    log('info', '✅ Botão "Tirar foto" clicado', cycle);
    await humanPause(randInt(sp(800), sp(1500)));
    return true;
  }

  // Fallback por texto
  const btnTexto = p.locator('button', { hasText: /Tirar foto/i }).first();
  if (await btnTexto.isVisible({ timeout: 2000 }).catch(() => false)) {
    await btnTexto.click({ timeout: 5000 });
    log('info', '✅ Botão "Tirar foto" clicado (fallback texto)', cycle);
    await humanPause(randInt(sp(800), sp(1500)));
    return true;
  }

  log('warn', '⚠️ Botão "Tirar foto" não encontrado', cycle);
  return false;
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

async function criarContextoCiclo(cycle: number): Promise<import('playwright').BrowserContext> {
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
  if (ctx) { await ctx.close().catch(() => {}); contextosPorCiclo.delete(cycle); }
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

async function etapa_aguardarOTP(
  p: Page, emailClient: IEmailClient, email: string,
  cycle: number, otpTimeoutMs = 120_000
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
    if (await p.locator(sel).first().isVisible({ timeout: 5000 }).catch(() => false)) {
      await humanTypeForce(p, sel, otp);
      log('info', '✅ OTP digitado', cycle);
      return;
    }
  }
  // Fallback: campos de dígito único
  const count = await p.locator('input[maxlength="1"]').count();
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

/**
 * Aguarda URL estabilizar (para de mudar por stableMs).
 */
async function aguardarNavegacaoEstabilizar(p: Page, maxWaitMs = 12_000, stableMs = 1_200): Promise<string> {
  const fim = Date.now() + maxWaitMs;
  let lastUrl = p.url();
  let lastChange = Date.now();
  while (Date.now() < fim) {
    await humanPause(250);
    const cur = p.url();
    if (cur !== lastUrl) { lastUrl = cur; lastChange = Date.now(); }
    else if (Date.now() - lastChange >= stableMs) break;
  }
  return p.url();
}

/**
 * Processa UMA tela de onboarding do Uber (pós-OTP).
 * Antes de tentar campos genéricos, verifica telas específicas conhecidas:
 *   1. WhatsApp opt-in → NÃO ATIVAR
 *   2. Hub KYC         → clica em Foto do perfil
 *   3. Tela de foto    → clica em Tirar foto
 * Depois faz a detecção genérica de nome/sobrenome/telefone/cidade/termos.
 */
async function processarTelaOnboarding(
  p: Page,
  payload: { nome: string; sobrenome: string; cidade: string; telefone: string },
  cycle: number,
  telaIdx: number
): Promise<boolean> {
  log('info', `📋 [Tela ${telaIdx}] Verificando tela de onboarding...`, cycle);

  // ── Telas específicas conhecidas ──────────────────────────────────────────
  if (await tratarTelaWhatsApp(p, cycle)) return true;
  if (await tratarHubKYC(p, cycle)) return true;
  if (await tratarTelaFotoPerfil(p, cycle)) return true;

  // ── Detecção genérica de campos ───────────────────────────────────────────
  let fezAlgo = false;

  // — Nome
  for (const sel of ['[data-testid*="first-name"]', '[name="firstName"]', '[id*="first"]', '[placeholder*="irst"]', '[placeholder*="ome"]']) {
    if (await p.locator(sel).first().isVisible({ timeout: 2000 }).catch(() => false)) {
      const val = await p.locator(sel).first().inputValue().catch(() => '');
      if (!val) {
        await humanTypeForce(p, sel, payload.nome);
        log('info', `✅ [Tela ${telaIdx}] Nome preenchido`, cycle);
        fezAlgo = true;
      }
      break;
    }
  }

  await humanPause(randInt(sp(150), sp(350)));

  // — Sobrenome
  for (const sel of ['[data-testid*="last-name"]', '[name="lastName"]', '[id*="last"]', '[placeholder*="ast"]', '[placeholder*="obrenome"]']) {
    if (await p.locator(sel).first().isVisible({ timeout: 2000 }).catch(() => false)) {
      const val = await p.locator(sel).first().inputValue().catch(() => '');
      if (!val) {
        await humanTypeForce(p, sel, payload.sobrenome);
        log('info', `✅ [Tela ${telaIdx}] Sobrenome preenchido`, cycle);
        fezAlgo = true;
      }
      break;
    }
  }

  await humanPause(randInt(sp(150), sp(350)));

  // — Telefone
  for (const sel of ['[name="phoneNumber"]', '[data-testid*="phone"]', 'input[type="tel"]', '[id*="phone"]']) {
    if (await p.locator(sel).first().isVisible({ timeout: 1500 }).catch(() => false)) {
      const val = await p.locator(sel).first().inputValue().catch(() => '');
      if (!val && payload.telefone) {
        await humanTypeForce(p, sel, payload.telefone);
        log('info', `✅ [Tela ${telaIdx}] Telefone preenchido`, cycle);
        fezAlgo = true;
      }
      break;
    }
  }

  await humanPause(randInt(sp(150), sp(350)));

  // — Cidade
  if (await p.locator('[data-testid="flow-type-city-selector-v2-input"]').first().isVisible({ timeout: 1500 }).catch(() => false)) {
    await selecionarCidade(p, payload.cidade, cycle);
    fezAlgo = true;
  }

  await cogPause(300, 700);

  // — Termos / checkboxes
  const aceitou = await tentarAceitarTermos(p);
  if (aceitou) { fezAlgo = true; await cogPause(300, 600); }

  // Verifica se há botão de avançar
  const temBotao = await p.locator('#forward-button, [data-testid="forward-button"], button[type="submit"]').first()
    .isVisible({ timeout: 2000 }).catch(() => false);

  if (!fezAlgo && !temBotao) {
    log('info', `💭 [Tela ${telaIdx}] Tela de transição sem campos/botão — aguardando navegação automática...`, cycle);
    return false;
  }

  await clickForwardButton(p, cycle);
  log('info', `👉 [Tela ${telaIdx}] Botão de avançar clicado`, cycle);
  return true;
}

/**
 * Loop pós-OTP: percorre TODAS as telas de onboarding do Uber até chegar
 * em isSuccessUrl (bonjour.uber.com/hub ou hub/step) ou atingir MAX_TELAS.
 */
async function etapa_posOTP(
  p: Page,
  payload: { nome: string; sobrenome: string; cidade: string; telefone: string },
  cycle: number
): Promise<'success' | 'onboarding' | 'unknown'> {
  const MAX_TELAS = 15;
  const MAX_TELA_TIMEOUT_MS = 20_000;

  for (let tela = 1; tela <= MAX_TELAS; tela++) {
    const url = await aguardarNavegacaoEstabilizar(p, MAX_TELA_TIMEOUT_MS, 1_200);
    log('info', `🔍 [Tela ${tela}] URL: ${url}`, cycle);

    if (isSuccessUrl(url)) {
      log('success', `🎉 Destino final detectado! URL: ${url}`, cycle);
      return 'success';
    }

    if (!isOnboardingUrl(url) && !url.includes('bonjour.uber.com')) {
      log('warn', `⚠️ URL não reconhecida: ${url}`, cycle);
      return 'unknown';
    }

    await p.waitForSelector(
      'input:not([type="hidden"]), button, [role="checkbox"], #forward-button, [data-testid="hub"], [data-testid="step whatsAppOptIn"], [data-testid="step profilePhoto"]',
      { timeout: 10_000 }
    ).catch(() => {});

    const clicou = await processarTelaOnboarding(p, payload, cycle, tela);

    if (!clicou) {
      const urlApos = await aguardarNavegacaoEstabilizar(p, 8_000, 2_000);
      if (urlApos === url) {
        log('warn', `⚠️ [Tela ${tela}] URL não avançou. Abortando loop.`, cycle);
        return isSuccessUrl(urlApos) ? 'success' : 'onboarding';
      }
    }
  }

  log('warn', `⚠️ Loop de onboarding atingiu limite de ${MAX_TELAS} telas`, cycle);
  return isSuccessUrl(p.url()) ? 'success' : 'onboarding';
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

    // 1. Email
    const emailClient: IEmailClient = createEmailClient(opts.emailProvider as any, opts.tempMailApiKey);
    const emailAccount = await emailClient.createRandomEmail();
    log('info', `📬 Email criado: ${emailAccount.email}`, cycle);

    const payload = gerarPayloadCompleto(emailAccount, opts.inviteCode);

    log('info', `🌐 Navegando para ${opts.cadastroUrl}`, cycle);
    await page.goto(opts.cadastroUrl, { waitUntil: 'domcontentloaded', timeout: 45_000 });
    await humanPause(randInt(sp(800), sp(1800)));
    await dispensarCookies(page);
    await pageWarmup(page, cycle);

    // 2. Email
    await etapa_digitarEmail(page, payload.email, cycle);
    await cogPause(400, 900);
    await tentarAceitarTermos(page);
    await clickForwardButton(page, cycle);
    await humanPause(randInt(sp(1200), sp(2500)));

    // 3. Senha (opcional)
    if (await page.locator('input[type="password"]').first().isVisible({ timeout: 8000 }).catch(() => false)) {
      await etapa_digitarSenha(page, payload.senha, cycle);
      await cogPause(500, 1100);
      await clickForwardButton(page, cycle);
      await humanPause(randInt(sp(1200), sp(2500)));
    }

    // 4. Nome/Sobrenome pré-OTP (se aparecer antes do OTP)
    if (await page.locator('[data-testid*="first-name"], [name="firstName"], [id*="first"]').first()
        .isVisible({ timeout: 8000 }).catch(() => false)) {
      const nomeSels = ['[data-testid*="first-name"]', '[name="firstName"]', '[id*="first"]'];
      for (const sel of nomeSels) {
        if (await page.locator(sel).first().isVisible({ timeout: 2000 }).catch(() => false)) {
          await humanTypeForce(page, sel, payload.nome); break;
        }
      }
      await humanPause(randInt(sp(300), sp(700)));
      const sobreSels = ['[data-testid*="last-name"]', '[name="lastName"]', '[id*="last"]'];
      for (const sel of sobreSels) {
        if (await page.locator(sel).first().isVisible({ timeout: 2000 }).catch(() => false)) {
          await humanTypeForce(page, sel, payload.sobrenome); break;
        }
      }
      await cogPause(400, 900);
      if (await page.locator('[data-testid="flow-type-city-selector-v2-input"]').first().isVisible({ timeout: 3000 }).catch(() => false)) {
        await selecionarCidade(page, payload.cidade, cycle);
      }
      await clickForwardButton(page, cycle);
      await humanPause(randInt(sp(1200), sp(2500)));
    }

    // 5. OTP
    const otpVisible = await page.locator(
      'input[autocomplete="one-time-code"], input[name="otpCode"], input[maxlength="1"]'
    ).first().isVisible({ timeout: 12000 }).catch(() => false);

    if (otpVisible) {
      const otp = await etapa_aguardarOTP(page, emailClient, payload.email, cycle, opts.otpTimeout);
      await etapa_digitarOTP(page, otp, cycle);
      await cogPause(400, 900);
      await clickForwardButton(page, cycle).catch(() => {});

      // 6. Loop pós-OTP: percorre todas as telas (WhatsApp, hub, foto, campos, etc.)
      const resultado = await etapa_posOTP(
        page,
        { nome: payload.nome, sobrenome: payload.sobrenome, cidade: payload.cidade, telefone: payload.telefone },
        cycle
      );

      if (resultado === 'success') {
        const urlFinal = page.url();
        log('success', `🎉 Conta criada com sucesso! URL: ${urlFinal}`, cycle);
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
      } else {
        const urlFinal = page.url();
        log('warn', `⚠️ Conta NÃO salva — fluxo incompleto. URL final: ${urlFinal}`, cycle);
      }
    } else {
      log('warn', '⚠️ Campo de OTP não apareceu', cycle);
    }

  } catch (err: any) {
    log('error', `❌ Erro no ciclo: ${err?.message ?? err}`, cycle);
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

  static async execute(cadastroUrl: string, opts: FlowOpts, cycle: number): Promise<void> {
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

  static async cleanup(): Promise<void> { await closeBrowser(); }
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
