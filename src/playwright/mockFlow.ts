import { chromium as chromiumExtra } from 'playwright-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import { Browser, Page, BrowserContext, devices } from 'playwright';
import type { Cookie } from 'playwright';
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
// FIX #1: viewport explícito 390×844 — o --window-size do args não afeta
// o viewport do contexto quando se usa devices[]. Definimos aqui para garantir
// que a página renderize como iPhone 14 real (390×844) e não com dimensões erradas.
const MOBILE_DEVICE = {
  ...devices['iPhone 14'],
  viewport: { width: 390, height: 844 },
  screen:   { width: 390, height: 844 },
};

// ─── Formato Tampermonkey ─────────────────────────────────────────────────────

function cookiesToTampermonkey(cookies: Cookie[]): [string, string, string, number, number, number][] {
  return cookies.map((c) => [
    c.name,
    c.value,
    c.domain,
    c.secure ? 1 : 0,
    c.httpOnly ? 1 : 0,
    c.expires > 0 ? Math.round(c.expires * 1000) : -1,
  ]);
}

function gerarTampermonkeyScript(cookies: Cookie[], email: string): string {
  const cookieArr = cookiesToTampermonkey(cookies);
  const cookieJson = JSON.stringify(cookieArr);
  const header = [
    '// ==UserScript==',
    '// @name         Uber Cookie Injector — ' + email,
    '// @namespace    http://tampermonkey.net/',
    '// @version      1.0',
    '// @description  Injeta cookies de sessão Uber',
    '// @author       MVP',
    '// @match        https://*.uber.com/*',
    '// @grant        GM_cookie',
    '// @run-at       document-start',
    '// ==/UserScript==',
  ].join('\n');
  const body =
    '(function(){' +
    'var H=window.location.hostname,C=' + cookieJson + ';' +
    'var ok=function(d){d=d.replace(/^[.]/,"");return H===d||H.endsWith("."+d)};' +
    'var EX=Date.now()+3154e7;' +
    'C.forEach(function(c){' +
    'var n=c[0],v=c[1],d=c[2],s=c[3],h=c[4],e=c[5]>0?c[5]:EX;' +
    'if(typeof GM_cookie!="undefined")GM_cookie.set({name:n,value:v,domain:d.replace(/^[.]/,""),path:"/",secure:!!s,httpOnly:!!h,expirationDate:Math.floor(e/1000)},function(){});' +
    'if(!h&&ok(d)){var ck=n+"="+v+";path=/;expires="+new Date(e).toUTCString()+(s?";secure":"")+";";' +
    'try{document.cookie=ck;}catch(x){}}' +
    '});' +
    'var RAN="__scr_done";' +
    'if(!sessionStorage.getItem(RAN)){sessionStorage.setItem(RAN,"1");' +
    'setTimeout(function(){location.href="https://account.uber.com/security";},800);}' +
    '})()';
  return header + '\n' + body;
}

// ─── Detecção de URL ──────────────────────────────────────────────────────────

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

function isOnboardingUrl(url: string): boolean {
  return (
    url.includes('auth.uber.com') ||
    url.includes('bonjour.uber.com') ||
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
  try {
    const uberTerms = p.locator('[data-testid="accept-terms"]');
    if (await uberTerms.isVisible({ timeout: 2000 }).catch(() => false)) {
      const cb = p.locator('input[type="checkbox"]').first();
      await cb.waitFor({ state: 'attached', timeout: 3000 });
      const box = await cb.boundingBox().catch(() => null);
      if (box) await humanMouseMove(p, box.x + box.width / 2, box.y + box.height / 2);
      await humanPause(randInt(sp(80), sp(160)));
      await cb.check({ force: true, timeout: 5000 });
      globalState.addLog('info', '☑️ Termos Uber aceitos (accept-terms)');
      return true;
    }
  } catch { /* continua */ }

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

// ─── Seleciona cidade + preenche invite code ──────────────────────────────────

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

async function preencherInviteCode(p: Page, inviteCode: string, cycle: number): Promise<void> {
  if (!inviteCode) return;
  const SEL = '[data-testid="signup-step::invite-code-input"]';
  const visible = await p.locator(SEL).first().isVisible({ timeout: 3000 }).catch(() => false);
  if (!visible) return;
  const val = await p.locator(SEL).first().inputValue().catch(() => '');
  if (val) { log('info', `🎟️ Invite code já preenchido: "${val}"`, cycle); return; }
  log('info', `🎟️ Preenchendo invite code: "${inviteCode}"`, cycle);
  await humanTypeForce(p, SEL, inviteCode);
  log('info', '✅ Invite code preenchido', cycle);
}

// ─── Tela WhatsApp opt-in ─────────────────────────────────────────────────────

async function tratarTelaWhatsApp(p: Page, cycle: number): Promise<boolean> {
  const isWhatsApp =
    await p.locator('[data-testid="step whatsAppOptIn"]').isVisible({ timeout: 3000 }).catch(() => false);
  if (!isWhatsApp) return false;

  log('info', '💬 Tela WhatsApp opt-in detectada — clicando NÃO ATIVAR', cycle);
  await cogPause(400, 900);

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

  const nav = p.locator('[data-testid="step-bottom-navigation"] button').first();
  if (await nav.isVisible({ timeout: 2000 }).catch(() => false)) {
    await nav.click({ timeout: 5000 });
    log('info', '✅ WhatsApp opt-in recusado (fallback nav)', cycle);
    await humanPause(randInt(sp(600), sp(1200)));
    return true;
  }

  return false;
}

// ─── Hub de KYC ──────────────────────────────────────────────────────────────

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

// ─── Tela de foto do perfil ───────────────────────────────────────────────────

async function tratarTelaFotoPerfil(p: Page, cycle: number): Promise<boolean> {
  const isFotoStep =
    await p.locator('[data-testid="step profilePhoto"]').isVisible({ timeout: 3000 }).catch(() => false);
  if (!isFotoStep) return false;

  log('info', '📷 Tela de foto do perfil detectada — clicando Tirar foto', cycle);
  await cogPause(600, 1200);

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

// ─── FIX #4: Tela de re-autenticação pós-OTP ─────────────────────────────────
//
// Após o OTP o Uber redireciona para auth.uber.com com um form que contém
// SIMULTANEAMENTE:
//   - INPUT[type=email][id=username]       ← email para confirmar identidade
//   - INPUT[type=password][id=PASSWORD]    ← senha da conta (novo-password)
//
// O processarTelaOnboarding não reconhecia esse par e ficava tentando clicar
// #forward-button (que não existe nessa tela — o submit é um button[type=submit]
// diferente). Agora detectamos o par e preenchemos ambos antes de submeter.

async function tratarTelaReAuth(
  p: Page,
  email: string,
  senha: string,
  cycle: number
): Promise<boolean> {
  const temEmail = await p.locator('#username[type="email"], input[id="username"]')
    .first().isVisible({ timeout: 3000 }).catch(() => false);
  const temSenha = await p.locator('#PASSWORD, input[autocomplete="new-password"], input[type="password"]')
    .first().isVisible({ timeout: 2000 }).catch(() => false);

  if (!temEmail || !temSenha) return false;

  log('info', '🔐 Tela re-auth pós-OTP detectada (username + password)', cycle);
  await cogPause(400, 800);

  // Preenche email (username)
  await forcarValorReact(p, '#username', email);
  await humanTypeForce(p, '#username', email);
  const emailVal = await p.locator('#username').inputValue().catch(() => '');
  if (emailVal !== email) await forcarValorReact(p, '#username', email);
  log('info', `✅ [re-auth] Email: "${await p.locator('#username').inputValue().catch(() => '')}"`, cycle);

  await humanPause(randInt(sp(300), sp(600)));

  // Preenche senha
  const senhaSels = ['#PASSWORD', 'input[autocomplete="new-password"]', 'input[type="password"]'];
  for (const sel of senhaSels) {
    if (await p.locator(sel).first().isVisible({ timeout: 2000 }).catch(() => false)) {
      await humanTypeForce(p, sel, senha);
      log('info', `✅ [re-auth] Senha digitada (${sel})`, cycle);
      break;
    }
  }

  await cogPause(400, 800);

  // Submete — o botão nessa tela é button[type=submit] ou #forward-button
  const submitSels = [
    'button[type="submit"]',
    '#forward-button',
    '[data-testid="forward-button"]',
    'button:has-text("Continuar")',
    'button:has-text("Continue")',
    'button:has-text("Entrar")',
    'button:has-text("Sign in")',
  ];
  for (const sel of submitSels) {
    const el = p.locator(sel).first();
    if (await el.isVisible({ timeout: 2000 }).catch(() => false)) {
      const box = await el.boundingBox().catch(() => null);
      if (box) await humanMouseMove(p, box.x + box.width * randFloat(0.3, 0.7), box.y + box.height * randFloat(0.3, 0.7));
      await humanPause(randInt(sp(150), sp(350)));
      await el.click({ timeout: 5000 });
      log('info', `🖱️ [re-auth] Botão submit clicado (${sel})`, cycle);
      await humanPause(randInt(sp(800), sp(1600)));
      return true;
    }
  }

  log('warn', '⚠️ [re-auth] Nenhum botão de submit encontrado', cycle);
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
        // FIX #1: window-size alinhado com o viewport 390×844 do MOBILE_DEVICE
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
  // FIX #1: viewport e screen explícitos para garantir 390×844 correto
  const ctx = await browser!.newContext({
    ...MOBILE_DEVICE,
    viewport: { width: 390, height: 844 },
    screen:   { width: 390, height: 844 },
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
  // FIX #2: fecha apenas o CONTEXTO do ciclo, nunca o browser global.
  // O browser só fecha via closeBrowser() no SIGINT/SIGTERM.
  if (ctx) { await ctx.close().catch(() => {}); contextosPorCiclo.delete(cycle); }
}

// ─── Etapas do flow ───────────────────────────────────────────────────────────

/**
 * FIX #3 — Digitar email no campo inicial.
 *
 * O campo #PHONE_NUMBER_or_EMAIL_ADDRESS do Uber é um React controlled input.
 * humanTypeForce já faz Ctrl+A + Delete, mas em algumas versões do Uber o
 * React re-renderiza o campo antes de receber os keydown events, resultando
 * em valor vazio no state interno do React mesmo com o DOM mostrando texto.
 *
 * Solução: antes de chamar humanTypeForce, forçamos o valor via nativeInputValueSetter
 * (hack React) para sincronizar o internal state, depois disparamos o evento
 * 'input' para que o React aceite o valor — e SÓ ENTÃO chamamos humanTypeForce
 * para que a cadeia completa de keydown/keyup seja registrada pelo Arkose.
 */
async function forcarValorReact(p: Page, selector: string, value: string): Promise<void> {
  await p.locator(selector).evaluate((el: HTMLInputElement, val: string) => {
    // Usa o setter nativo do HTMLInputElement para bypassar o React proxy
    const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype, 'value'
    )?.set;
    if (nativeInputValueSetter) {
      nativeInputValueSetter.call(el, val);
    } else {
      el.value = val;
    }
    // Dispara input + change para o React sincronizar o state interno
    el.dispatchEvent(new InputEvent('input',  { bubbles: true, cancelable: false, composed: true, data: val, inputType: 'insertText' }));
    el.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));
  }, value).catch(() => {});
}

async function etapa_digitarEmailOuTelefone(p: Page, email: string, cycle: number): Promise<void> {
  log('info', `📧 Digitando email: ${email}`, cycle);

  const SELS = [
    '#PHONE_NUMBER_or_EMAIL_ADDRESS',
    '#EMAIL_ADDRESS',
    'input[autocomplete="email"]',
    'input[type="email"]',
    '#PHONE_NUMBER',
    'input[autocomplete="tel-national"]',
    'input[type="tel"]',
    'input[inputmode="tel"]',
  ];

  for (const SEL of SELS) {
    const visible = await p.locator(SEL).first().isVisible({ timeout: 5000 }).catch(() => false);
    if (visible) {
      log('info', `[DEBUG] Campo "${SEL}" → "${email}"`, cycle);

      // FIX #3: limpa forçadamente via React nativeInputValueSetter antes de digitar
      await p.locator(SEL).evaluate((el: HTMLInputElement) => {
        const nativeSet = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
        if (nativeSet) nativeSet.call(el, '');
        else el.value = '';
        el.dispatchEvent(new InputEvent('input', { bubbles: true, cancelable: false, composed: true, data: '', inputType: 'deleteContentBackward' }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      }).catch(() => {});
      await humanPause(randInt(sp(80), sp(160)));

      // Digita normalmente com a cadeia completa de eventos (Arkose-safe)
      await humanTypeForce(p, SEL, email);

      // Verifica se o valor ficou correto; se não, força via React setter
      const val = await p.locator(SEL).inputValue().catch(() => '');
      if (val !== email) {
        log('warn', `⚠️ Valor pós-digitação "${val}" ≠ email esperado — forçando via React setter`, cycle);
        await forcarValorReact(p, SEL, email);
        await humanPause(randInt(sp(200), sp(400)));
      }

      const finalVal = await p.locator(SEL).inputValue().catch(() => '');
      log('info', `✅ Email digitado — valor final: "${finalVal}"`, cycle);
      return;
    }
  }

  throw new Error('Campo de email/telefone não encontrado em nenhum seletor conhecido');
}

/**
 * FIX #5 — Tela de senha (etapa_digitarSenha).
 *
 * Diagnóstico via DevTools confirmou:
 *   - #PASSWORD  → visible: true, autocomplete: "new-password", value: [vazio]
 *   - #forward-button → disabled: true
 *
 * O #PASSWORD é um React controlled input. Apenas humanTypeForce não é
 * suficiente para habilitar o #forward-button porque o React state interno
 * nunca é sincronizado. Solução: forcarValorReact ANTES de humanTypeForce,
 * igual ao padrão já usado no campo de email (FIX #3).
 *
 * Após digitar, verificamos o valor e aguardamos o botão habilitar antes
 * de prosseguir para o clickForwardButton.
 */
async function etapa_digitarSenha(p: Page, senha: string, cycle: number): Promise<void> {
  log('info', '🔑 Digitando senha...', cycle);

  const SELS = [
    '#PASSWORD',
    'input[autocomplete="new-password"]',
    'input[autocomplete="current-password"]',
    'input[name="password"]',
    'input[type="password"]',
  ];

  for (const SEL of SELS) {
    const visible = await p.locator(SEL).first().isVisible({ timeout: 5000 }).catch(() => false);
    if (visible) {
      log('info', `🔑 Campo senha encontrado: "${SEL}"`, cycle);

      // FIX #5a: limpa via React nativeInputValueSetter antes de digitar
      await p.locator(SEL).evaluate((el: HTMLInputElement) => {
        const nativeSet = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
        if (nativeSet) nativeSet.call(el, '');
        else el.value = '';
        el.dispatchEvent(new InputEvent('input', { bubbles: true, cancelable: false, composed: true, data: '', inputType: 'deleteContentBackward' }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      }).catch(() => {});
      await humanPause(randInt(sp(80), sp(160)));

      // FIX #5b: força o valor via React setter para habilitar o #forward-button
      await forcarValorReact(p, SEL, senha);
      await humanPause(randInt(sp(120), sp(240)));

      // Digita normalmente para registrar keydown/keyup no Arkose
      await humanTypeForce(p, SEL, senha);

      // FIX #5c: verifica valor final e re-força se necessário
      const val = await p.locator(SEL).inputValue().catch(() => '');
      if (val !== senha) {
        log('warn', `⚠️ Valor pós-digitação da senha incorreto — forçando via React setter`, cycle);
        await forcarValorReact(p, SEL, senha);
        await humanPause(randInt(sp(200), sp(400)));
      }

      // FIX #5d: aguarda o #forward-button habilitar (até 3s) antes de retornar
      const fwdBtn = p.locator('#forward-button, [data-testid="forward-button"]').first();
      const habilitado = await fwdBtn.waitFor({ state: 'visible', timeout: 3000 })
        .then(() => fwdBtn.isEnabled({ timeout: 3000 }))
        .catch(() => false);
      if (!habilitado) {
        log('warn', '⚠️ #forward-button ainda disabled após senha — disparando blur para forçar validação React', cycle);
        await p.locator(SEL).evaluate((el) => {
          el.dispatchEvent(new FocusEvent('blur', { bubbles: true }));
        }).catch(() => {});
        await humanPause(randInt(sp(300), sp(600)));
      }

      log('info', '✅ Senha digitada', cycle);
      return;
    }
  }

  throw new Error('Campo de senha não encontrado');
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

/**
 * Digita o OTP nos campos individuais do Uber (EMAIL_OTP_CODE-0..3).
 */
async function etapa_digitarOTP(p: Page, otp: string, cycle: number): Promise<void> {
  log('info', `🔢 Digitando OTP: ${otp}`, cycle);

  const primeroCampoUber = p.locator('#EMAIL_OTP_CODE-0');
  if (await primeroCampoUber.isVisible({ timeout: 5000 }).catch(() => false)) {
    log('info', '🔢 OTP em campos individuais EMAIL_OTP_CODE-N', cycle);
    for (let i = 0; i < otp.length; i++) {
      const campo = p.locator(`#EMAIL_OTP_CODE-${i}`);
      await campo.waitFor({ state: 'visible', timeout: 5000 }).catch(() => {});
      await focusField(p, `#EMAIL_OTP_CODE-${i}`);
      await humanPause(randInt(sp(60), sp(140)));
      await _typeChar(p, otp[i]!, isSpeedMode());
      await humanPause(randInt(sp(80), sp(200)));
    }
    log('info', '✅ OTP digitado (EMAIL_OTP_CODE-N)', cycle);
    return;
  }

  const camposOtp = p.locator('input[autocomplete="one-time-code"]');
  const totalOtp = await camposOtp.count().catch(() => 0);
  if (totalOtp >= 2) {
    log('info', `🔢 OTP em ${totalOtp} campos autocomplete=one-time-code`, cycle);
    for (let i = 0; i < Math.min(totalOtp, otp.length); i++) {
      const campo = camposOtp.nth(i);
      await campo.waitFor({ state: 'visible', timeout: 4000 }).catch(() => {});
      const box = await campo.boundingBox().catch(() => null);
      if (box) await humanMouseMove(p, box.x + box.width / 2, box.y + box.height / 2);
      await campo.click({ timeout: 3000 }).catch(() => {});
      await humanPause(randInt(sp(60), sp(130)));
      await _typeChar(p, otp[i]!, isSpeedMode());
      await humanPause(randInt(sp(80), sp(180)));
    }
    log('info', '✅ OTP digitado (autocomplete individual)', cycle);
    return;
  }

  const candidatosUnicos = [
    'input[name="otpCode"]',
    'input[autocomplete="one-time-code"]',
    '[data-testid*="otp"]',
    '[data-testid*="code"]',
    'input[inputmode="numeric"][maxlength="6"]',
    'input[inputmode="numeric"]',
    'input[maxlength="1"]',
  ];
  for (const sel of candidatosUnicos) {
    if (await p.locator(sel).first().isVisible({ timeout: 3000 }).catch(() => false)) {
      const count = await p.locator(sel).count();
      if (count >= 2) {
        log('info', `🔢 OTP em ${count} campos "${sel}"`, cycle);
        for (let i = 0; i < Math.min(count, otp.length); i++) {
          const campo = p.locator(sel).nth(i);
          await campo.waitFor({ state: 'visible', timeout: 3000 }).catch(() => {});
          await campo.click({ timeout: 3000 }).catch(() => {});
          await humanPause(randInt(sp(60), sp(120)));
          await _typeChar(p, otp[i]!, isSpeedMode());
          await humanPause(randInt(sp(80), sp(160)));
        }
        log('info', '✅ OTP digitado (múltiplos campos fallback)', cycle);
        return;
      }
      await humanTypeForce(p, sel, otp);
      log('info', '✅ OTP digitado (campo único)', cycle);
      return;
    }
  }

  throw new Error('Campo de OTP não encontrado');
}

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

async function preencherTelefone(p: Page, telefone: string, cycle: number): Promise<boolean> {
  const PHONE_SELS = [
    '#PHONE_NUMBER',
    '[name="phoneNumber"]',
    'input[autocomplete="tel-national"]',
    'input[type="tel"]',
    '[id*="phone"]',
    '[placeholder*="celular"]',
    '[placeholder*="telefone"]',
    '[placeholder*="phone"]',
    'input[inputmode="tel"]',
  ];

  for (const sel of PHONE_SELS) {
    try {
      const el = p.locator(sel).first();
      const visible = await el.isVisible({ timeout: 2000 }).catch(() => false);
      if (!visible) continue;

      const val = await el.inputValue().catch(() => '');
      if (val) {
        log('info', `📱 [telefone] Campo "${sel}" já preenchido: "${val}"`, cycle);
        return true;
      }

      log('info', `📱 Preenchendo telefone "${telefone}" em "${sel}"`, cycle);
      await humanTypeForce(p, sel, telefone);
      log('info', '✅ Telefone preenchido', cycle);
      return true;
    } catch { /* continua */ }
  }
  return false;
}

async function processarTelaOnboarding(
  p: Page,
  payload: { nome: string; sobrenome: string; cidade: string; telefone: string; inviteCode: string; email: string; senha: string },
  cycle: number,
  telaIdx: number
): Promise<boolean> {
  log('info', `📋 [Tela ${telaIdx}] Verificando tela de onboarding...`, cycle);

  if (await tratarTelaWhatsApp(p, cycle)) return true;
  if (await tratarHubKYC(p, cycle)) return true;
  if (await tratarTelaFotoPerfil(p, cycle)) return true;

  // FIX #4: detecta tela de re-auth (username + password juntos) ANTES do fluxo genérico
  if (await tratarTelaReAuth(p, payload.email, payload.senha, cycle)) return true;

  try {
    const inputs = await p.$$eval('input:not([type="hidden"])', (els) =>
      els.map((el) => {
        const e = el as HTMLInputElement;
        return `${e.tagName}[type=${e.type}][id=${e.id}][autocomplete=${e.autocomplete}][placeholder=${e.placeholder}]`;
      })
    );
    if (inputs.length > 0) {
      log('info', `🔎 [Tela ${telaIdx}] Inputs: ${inputs.slice(0, 6).join(' | ')}`, cycle);
    }
  } catch { /* ignora */ }

  let fezAlgo = false;

  const nomeSels = ['#FIRST_NAME', '[autocomplete="given-name"]', '[data-testid*="first-name"]', '[name="firstName"]', '[id*="first"]', '[placeholder*="rimeiro"]'];
  for (const sel of nomeSels) {
    if (await p.locator(sel).first().isVisible({ timeout: 2000 }).catch(() => false)) {
      const val = await p.locator(sel).first().inputValue().catch(() => '');
      if (!val) {
        await humanTypeForce(p, sel, payload.nome);
        log('info', `✅ [Tela ${telaIdx}] Nome preenchido (${sel})`, cycle);
        fezAlgo = true;
      }
      break;
    }
  }

  await humanPause(randInt(sp(150), sp(350)));

  const sobreSels = ['#LAST_NAME', '[autocomplete="family-name"]', '[data-testid*="last-name"]', '[name="lastName"]', '[id*="last"]', '[placeholder*="obrenome"]'];
  for (const sel of sobreSels) {
    if (await p.locator(sel).first().isVisible({ timeout: 2000 }).catch(() => false)) {
      const val = await p.locator(sel).first().inputValue().catch(() => '');
      if (!val) {
        await humanTypeForce(p, sel, payload.sobrenome);
        log('info', `✅ [Tela ${telaIdx}] Sobrenome preenchido (${sel})`, cycle);
        fezAlgo = true;
      }
      break;
    }
  }

  await humanPause(randInt(sp(150), sp(350)));

  const telefonePreenchido = await preencherTelefone(p, payload.telefone, cycle);
  if (telefonePreenchido) {
    fezAlgo = true;
    await cogPause(600, 1200);
  }

  await humanPause(randInt(sp(150), sp(350)));

  if (await p.locator('[data-testid="flow-type-city-selector-v2-input"]').first().isVisible({ timeout: 1500 }).catch(() => false)) {
    await selecionarCidade(p, payload.cidade, cycle);
    fezAlgo = true;
    await humanPause(randInt(sp(400), sp(800)));
    await preencherInviteCode(p, payload.inviteCode, cycle);
  }

  await cogPause(300, 700);

  const aceitou = await tentarAceitarTermos(p);
  if (aceitou) { fezAlgo = true; await cogPause(300, 600); }

  const temBotao = await p.locator(
    '#forward-button, [data-testid="forward-button"], [data-testid="submit-button"], button[type="submit"]'
  ).first().isVisible({ timeout: 2000 }).catch(() => false);

  if (!fezAlgo && !temBotao) {
    log('info', `💭 [Tela ${telaIdx}] Tela de transição sem campos/botão — aguardando navegação automática...`, cycle);
    return false;
  }

  await clickForwardButton(p, cycle);
  log('info', `👉 [Tela ${telaIdx}] Botão de avançar clicado`, cycle);
  return true;
}

async function etapa_posOTP(
  p: Page,
  payload: { nome: string; sobrenome: string; cidade: string; telefone: string; inviteCode: string; email: string; senha: string },
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

    if (!isOnboardingUrl(url)) {
      log('warn', `⚠️ URL não reconhecida: ${url}`, cycle);
      return 'unknown';
    }

    await p.waitForSelector(
      'input:not([type="hidden"]), button, [role="checkbox"], #forward-button, [data-testid="hub"], [data-testid="step whatsAppOptIn"], [data-testid="step profilePhoto"], [data-testid="submit-button"]',
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

    const emailClient: IEmailClient = createEmailClient(opts.emailProvider as any, opts.tempMailApiKey);
    const emailAccount = await emailClient.createRandomEmail();
    log('info', `📬 Email criado: ${emailAccount.email}`, cycle);

    const payload = gerarPayloadCompleto(emailAccount, opts.inviteCode);

    log('info', `🌐 Navegando para ${opts.cadastroUrl}`, cycle);
    await page.goto(opts.cadastroUrl, { waitUntil: 'domcontentloaded', timeout: 45_000 });
    await humanPause(randInt(sp(800), sp(1800)));
    await dispensarCookies(page);
    await pageWarmup(page, cycle);

    const isTelaCampoInicial = await page.locator(
      '#PHONE_NUMBER_or_EMAIL_ADDRESS, #EMAIL_ADDRESS, input[type="email"], #PHONE_NUMBER, input[autocomplete="tel-national"]'
    ).first().isVisible({ timeout: 12000 }).catch(() => false);

    if (!isTelaCampoInicial) {
      log('warn', '⚠️ Tela inicial não detectada — tentando loop de onboarding direto', cycle);
      const resultado = await etapa_posOTP(
        page,
        { nome: payload.nome, sobrenome: payload.sobrenome, cidade: payload.cidade, telefone: payload.telefone, inviteCode: opts.inviteCode, email: payload.email, senha: payload.senha },
        cycle
      );
      if (resultado !== 'success') log('warn', `⚠️ Flow incompleto (sem tela inicial). URL: ${page.url()}`, cycle);
      return;
    }

    // Etapa 1: sempre usa o EMAIL
    await etapa_digitarEmailOuTelefone(page, payload.email, cycle);
    await cogPause(400, 900);
    await clickForwardButton(page, cycle);
    await aguardarNavegacaoEstabilizar(page, 6_000, 1_000);

    const senhaVisible = await page.locator(
      '#PASSWORD, input[autocomplete="new-password"], input[autocomplete="current-password"], input[type="password"]'
    ).first().isVisible({ timeout: 8000 }).catch(() => false);

    if (senhaVisible) {
      await etapa_digitarSenha(page, payload.senha, cycle);
      await cogPause(500, 1100);
      await clickForwardButton(page, cycle);
      await aguardarNavegacaoEstabilizar(page, 6_000, 1_000);
    }

    const nomeVisible = await page.locator(
      '#FIRST_NAME, [autocomplete="given-name"]'
    ).first().isVisible({ timeout: 8000 }).catch(() => false);

    if (nomeVisible) {
      const nomeSels = ['#FIRST_NAME', '[autocomplete="given-name"]', '[name="firstName"]'];
      for (const sel of nomeSels) {
        if (await page.locator(sel).first().isVisible({ timeout: 2000 }).catch(() => false)) {
          await humanTypeForce(page, sel, payload.nome); break;
        }
      }
      await humanPause(randInt(sp(300), sp(700)));
      const sobreSels = ['#LAST_NAME', '[autocomplete="family-name"]', '[name="lastName"]'];
      for (const sel of sobreSels) {
        if (await page.locator(sel).first().isVisible({ timeout: 2000 }).catch(() => false)) {
          await humanTypeForce(page, sel, payload.sobrenome); break;
        }
      }
      await cogPause(400, 900);
      await tentarAceitarTermos(page);
      await clickForwardButton(page, cycle);
      await aguardarNavegacaoEstabilizar(page, 6_000, 1_000);
    }

    const termosVisible = await page.locator('[data-testid="accept-terms"]').first()
      .isVisible({ timeout: 5000 }).catch(() => false);
    if (termosVisible) {
      await tentarAceitarTermos(page);
      await cogPause(400, 800);
      await clickForwardButton(page, cycle);
      await aguardarNavegacaoEstabilizar(page, 6_000, 1_000);
    }

    const otpVisible = await page.locator(
      '#EMAIL_OTP_CODE-0, input[autocomplete="one-time-code"], input[name="otpCode"], input[maxlength="1"]'
    ).first().isVisible({ timeout: 12000 }).catch(() => false);

    if (otpVisible) {
      const otp = await etapa_aguardarOTP(page, emailClient, payload.email, cycle, opts.otpTimeout);
      await etapa_digitarOTP(page, otp, cycle);

      log('info', '⏳ Aguardando navegação automática pós-OTP...', cycle);
      await aguardarNavegacaoEstabilizar(page, 8_000, 1_500);

      const resultado = await etapa_posOTP(
        page,
        { nome: payload.nome, sobrenome: payload.sobrenome, cidade: payload.cidade, telefone: payload.telefone, inviteCode: opts.inviteCode, email: payload.email, senha: payload.senha },
        cycle
      );

      if (resultado === 'success') {
        const urlFinal = page.url();
        const cookiesRaw: Cookie[] = await ctx.cookies().catch(() => []);
        log('info', `🍪 ${cookiesRaw.length} cookies capturados`, cycle);

        const tmScript = gerarTampermonkeyScript(cookiesRaw, payload.email);
        log('success', `📋 Tampermonkey Script:\n${tmScript}`, cycle);

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
          cookies: cookiesRaw,
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
    // FIX #2: fecha APENAS o contexto isolado do ciclo.
    // O browser global permanece aberto para o próximo ciclo.
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

  // Chamado apenas no SIGINT/SIGTERM — nunca durante ciclos normais
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
    cadastroUrl: (config as any).cadastroUrl ?? 'https://www.uber.com/br/pt-br/drive/application/',
    emailProvider: emailProvider ?? config.emailProvider,
    tempMailApiKey: config.tempMailApiKey ?? '',
    otpTimeout: config.otpTimeout ?? 120_000,
    extraDelay: config.extraDelay ?? 0,
    inviteCode: config.inviteCode ?? '',
  });
}
