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

// Sem timeout global de ciclo.
// A guia fecha APENAS em dois casos:
//   1. KYC Veriff detectado (isVeriffUrl / elemento veriff na tela)
//   2. Uma única etapa ficou travada por mais de STEP_STALL_TIMEOUT_MS
const STEP_STALL_TIMEOUT_MS = 5 * 60 * 1_000; // 5 minutos por etapa

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

/** Retorna true se a URL ou conteúdo da página indica KYC Veriff. */
function isVeriffUrl(url: string): boolean {
  return (
    url.includes('veriff.com') ||
    url.includes('veriff.me') ||
    url.includes('veriff.app') ||
    url.includes('kyc.uber') ||
    url.includes('/veriff') ||
    url.includes('identity-verification')
  );
}

async function detectarVeriff(p: Page): Promise<boolean> {
  if (isVeriffUrl(p.url())) return true;
  const seletoresVeriff = [
    '[data-testid="veriff-container"]',
    'iframe[src*="veriff"]',
    '.veriff-container',
    '[class*="veriff"]',
    'img[alt*="Veriff"]',
    'button:has-text("Start verification")',
    'button:has-text("Iniciar verificação")',
  ];
  for (const sel of seletoresVeriff) {
    if (await p.locator(sel).first().isVisible({ timeout: 500 }).catch(() => false)) return true;
  }
  return false;
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
      if (await el.isVisible({ timeout: 500 }).catch(() => false)) {
        await hoverElement(p, seletor);
        await el.click({ timeout: 2000 });
        globalState.addLog('info', `Banner de cookies dispensado (${seletor})`);
        await humanPause(randInt(sp(100), sp(200)));
        return;
      }
    } catch { /* ignora */ }
  }
}

// ─── Aceitar termos ───────────────────────────────────────────────────────────
/**
 * Marca TODOS os checkboxes de termos presentes na tela.
 *
 * Estratégia por ordem de prioridade para cada checkbox encontrado:
 *   1. Clica no <label> associado (for=id) — funciona em checkboxes customizados Uber
 *      que usam label estilizado e escondem o input nativo
 *   2. Se label não encontrado, tenta click() direto no input com { force: true }
 *   3. Se ainda unchecked, tenta check() com { force: true } como último recurso
 *   4. Verifica via JS se ficou checked; se não, repete mais uma vez via JS dispatchEvent
 *
 * Aguarda até 2s o forward-button habilitar após marcar todos os checkboxes.
 */
async function tentarAceitarTermos(p: Page, cycle?: number): Promise<boolean> {
  // ── Seletores de container de termos conhecidos (prioridade 1) ──
  const containersSels = [
    '[data-testid="accept-terms"]',
    '[data-testid*="terms"]',
    '[data-testid*="consent"]',
    '[data-testid*="agree"]',
  ];

  // Coleta todos os checkboxes visíveis/attached da página
  async function coletarCheckboxes() {
    // inputs nativos
    const nativos = p.locator('input[type="checkbox"]');
    const nCount = await nativos.count().catch(() => 0);
    // role=checkbox (customizados)
    const roles = p.locator('[role="checkbox"]');
    const rCount = await roles.count().catch(() => 0);
    return { nativos, nCount, roles, rCount };
  }

  const { nCount, rCount } = await coletarCheckboxes();
  if (nCount === 0 && rCount === 0) return false;

  let marcouAlgum = false;

  // ── Função core: marcar um único checkbox com todas as estratégias ──
  async function marcarCheckbox(cb: import('playwright').Locator, idx: number): Promise<boolean> {
    // Verifica se já está marcado
    const jaMarcado = await cb.evaluate((el: HTMLInputElement) =>
      el.checked !== undefined ? el.checked : el.getAttribute('aria-checked') === 'true'
    ).catch(() => false);
    if (jaMarcado) {
      if (cycle !== undefined) log('info', `[termos] Checkbox #${idx} ja marcado — pulando`, cycle);
      return true;
    }

    await cb.waitFor({ state: 'attached', timeout: 2000 }).catch(() => {});

    // Move mouse para o centro do checkbox
    const box = await cb.boundingBox().catch(() => null);
    if (box) await humanMouseMove(p, box.x + box.width / 2, box.y + box.height / 2);
    await humanPause(randInt(sp(40), sp(80)));

    // Estratégia 1: clicar no <label for="id"> associado ao input
    let clicouLabel = false;
    try {
      const id = await cb.getAttribute('id').catch(() => null);
      if (id) {
        const label = p.locator(`label[for="${id}"]`).first();
        const labelVisible = await label.isVisible({ timeout: 800 }).catch(() => false);
        if (labelVisible) {
          const lbox = await label.boundingBox().catch(() => null);
          if (lbox) await humanMouseMove(p, lbox.x + lbox.width * randFloat(0.3, 0.7), lbox.y + lbox.height * randFloat(0.3, 0.7));
          await humanPause(randInt(sp(30), sp(70)));
          await label.click({ force: true, timeout: 3000 });
          clicouLabel = true;
          if (cycle !== undefined) log('info', `[termos] Checkbox #${idx} marcado via label[for="${id}"]`, cycle);
        }
      }
    } catch { /* fallback */ }

    // Estratégia 2: click direto no input com force
    if (!clicouLabel) {
      try {
        await cb.click({ force: true, timeout: 3000 });
        if (cycle !== undefined) log('info', `[termos] Checkbox #${idx} marcado via click(force)`, cycle);
      } catch { /* fallback */ }
    }

    await humanPause(randInt(sp(60), sp(120)));

    // Verifica se ficou marcado
    const checkedApos = await cb.evaluate((el: HTMLInputElement) =>
      el.checked !== undefined ? el.checked : el.getAttribute('aria-checked') === 'true'
    ).catch(() => false);

    // Estratégia 3: check() nativo como último recurso
    if (!checkedApos) {
      try {
        await cb.check({ force: true, timeout: 3000 });
        if (cycle !== undefined) log('info', `[termos] Checkbox #${idx} marcado via .check(force)`, cycle);
      } catch { /* ignora */ }
      await humanPause(randInt(sp(40), sp(80)));
    }

    // Estratégia 4: forçar via JS change event (checkbox React customizado)
    const checkedFinal = await cb.evaluate((el: HTMLInputElement) =>
      el.checked !== undefined ? el.checked : el.getAttribute('aria-checked') === 'true'
    ).catch(() => false);
    if (!checkedFinal) {
      await cb.evaluate((el: HTMLInputElement) => {
        if (el.type === 'checkbox') {
          const nativeSet = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'checked')?.set;
          if (nativeSet) nativeSet.call(el, true);
          else el.checked = true;
        } else {
          el.setAttribute('aria-checked', 'true');
        }
        el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, composed: true }));
        el.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));
        el.dispatchEvent(new Event('input',  { bubbles: true, cancelable: true }));
      }).catch(() => {});
      await humanPause(randInt(sp(40), sp(80)));
      if (cycle !== undefined) log('info', `[termos] Checkbox #${idx} forcado via JS setter+events`, cycle);
    }

    return true;
  }

  // ── Marcar todos os inputs[type=checkbox] ──
  const { nativos, nCount: nc2 } = await coletarCheckboxes();
  for (let i = 0; i < nc2; i++) {
    try {
      const cb = nativos.nth(i);
      const visible = await cb.isVisible({ timeout: 800 }).catch(() => false);
      const attached = await cb.count().then((n) => n > 0).catch(() => false);
      if (!visible && !attached) continue;
      await marcarCheckbox(cb, i);
      marcouAlgum = true;
    } catch { /* continua */ }
  }

  // ── Marcar todos os [role=checkbox] não já cobertos ──
  const { roles, rCount: rc2 } = await coletarCheckboxes();
  for (let i = 0; i < rc2; i++) {
    try {
      const cb = roles.nth(i);
      const visible = await cb.isVisible({ timeout: 800 }).catch(() => false);
      if (!visible) continue;
      await marcarCheckbox(cb, i + 1000);
      marcouAlgum = true;
    } catch { /* continua */ }
  }

  // ── Fallback: labels de termos com texto ──
  if (!marcouAlgum) {
    const labelSel = 'label:has-text("Concordo"), label:has-text("Agree"), label:has-text("aceito"), label:has-text("accept"), label:has-text("termos"), label:has-text("terms")';
    const labels = p.locator(labelSel);
    const lCount = await labels.count().catch(() => 0);
    for (let i = 0; i < lCount; i++) {
      try {
        const lbl = labels.nth(i);
        if (!await lbl.isVisible({ timeout: 800 }).catch(() => false)) continue;
        const lbox = await lbl.boundingBox().catch(() => null);
        if (lbox) await humanMouseMove(p, lbox.x + lbox.width * randFloat(0.3, 0.7), lbox.y + lbox.height * randFloat(0.3, 0.7));
        await humanPause(randInt(sp(30), sp(70)));
        await lbl.click({ force: true, timeout: 3000 });
        marcouAlgum = true;
        if (cycle !== undefined) log('info', `[termos] Label de texto clicado (fallback)`, cycle);
      } catch { /* continua */ }
    }
  }

  if (marcouAlgum) {
    if (cycle !== undefined) log('info', '[termos] Termos aceitos', cycle);
    // Aguarda o forward-button habilitar (até 2s) após marcar
    await p.locator('#forward-button, [data-testid="forward-button"]')
      .first()
      .waitFor({ state: 'visible', timeout: 2000 })
      .catch(() => {});
  }

  return marcouAlgum;
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

  log('info', `Digitando cidade: "${nomeBusca}"`, cycle);
  await p.waitForSelector(INPUT_SEL, { state: 'visible', timeout: 10000 });
  await focusField(p, INPUT_SEL);
  await p.fill(INPUT_SEL, '');
  await humanPause(randInt(sp(50), sp(100)));
  for (const ch of nomeBusca) {
    await _typeChar(p, ch, isSpeedMode());
    if (!isSpeedMode() && Math.random() < 0.06) await humanPause(randInt(40, 100));
  }

  let itemSel: string | null = null;
  const pollMs = isSpeedMode() ? 100 : 200;
  const fimDropdown = Date.now() + 5_000;
  while (Date.now() < fimDropdown) {
    for (const sel of DROPDOWN_ITEM_SELS) {
      try {
        if (await p.locator(sel).count() > 0 &&
            await p.locator(sel).first().isVisible({ timeout: 400 }).catch(() => false)) {
          itemSel = sel; break;
        }
      } catch { /* continua */ }
    }
    if (itemSel) break;
    await humanPause(pollMs);
  }

  if (!itemSel) {
    log('warn', 'Dropdown nao detectado, tentando ArrowDown+Enter', cycle);
    await p.keyboard.press('ArrowDown');
    await humanPause(randInt(sp(80), sp(150)));
    await p.keyboard.press('Enter');
    return;
  }

  await humanPause(randInt(sp(100), sp(250)));
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
        await humanPause(randInt(sp(60), sp(130)));
        await opcao.click({ timeout: 4000 });
        clicou = true;
        log('info', `Cidade selecionada: "${texto.trim()}"`, cycle);
        break;
      }
    } catch { /* continua */ }
  }
  if (!clicou) {
    await p.keyboard.press('ArrowDown');
    await humanPause(randInt(sp(80), sp(150)));
    await p.keyboard.press('Enter');
  }
}

async function preencherInviteCode(p: Page, inviteCode: string, cycle: number): Promise<void> {
  if (!inviteCode) return;
  const SEL = '[data-testid="signup-step::invite-code-input"]';
  const visible = await p.locator(SEL).first().isVisible({ timeout: 1500 }).catch(() => false);
  if (!visible) return;
  const val = await p.locator(SEL).first().inputValue().catch(() => '');
  if (val) { log('info', `Invite code ja preenchido: "${val}"`, cycle); return; }
  log('info', `Preenchendo invite code: "${inviteCode}"`, cycle);
  await humanTypeForce(p, SEL, inviteCode);
  log('info', 'Invite code preenchido', cycle);
}

// ─── Tela WhatsApp opt-in ─────────────────────────────────────────────────────

async function tratarTelaWhatsApp(p: Page, cycle: number): Promise<boolean> {
  const isWhatsApp =
    await p.locator('[data-testid="step whatsAppOptIn"]').isVisible({ timeout: 1500 }).catch(() => false);
  if (!isWhatsApp) return false;

  log('info', 'Tela WhatsApp opt-in detectada — clicando NAO ATIVAR', cycle);
  await cogPause(150, 350);

  const btn = p.locator('button', { hasText: /NÃO ATIVAR/i }).first();
  if (await btn.isVisible({ timeout: 1500 }).catch(() => false)) {
    const box = await btn.boundingBox().catch(() => null);
    if (box) await humanMouseMove(p, box.x + box.width * randFloat(0.3, 0.7), box.y + box.height * randFloat(0.3, 0.7));
    await humanPause(randInt(sp(60), sp(130)));
    await btn.click({ timeout: 4000 });
    log('info', 'WhatsApp opt-in recusado', cycle);
    await humanPause(randInt(sp(300), sp(500)));
    return true;
  }

  const nav = p.locator('[data-testid="step-bottom-navigation"] button').first();
  if (await nav.isVisible({ timeout: 1000 }).catch(() => false)) {
    await nav.click({ timeout: 4000 });
    log('info', 'WhatsApp opt-in recusado (fallback nav)', cycle);
    await humanPause(randInt(sp(300), sp(500)));
    return true;
  }

  return false;
}

// ─── Hub de KYC ──────────────────────────────────────────────────────────────

async function tratarHubKYC(p: Page, cycle: number): Promise<boolean> {
  const isHub =
    await p.locator('[data-testid="hub"]').isVisible({ timeout: 1500 }).catch(() => false);
  if (!isHub) return false;

  log('info', 'Hub KYC detectado — clicando em Foto do perfil', cycle);
  await cogPause(200, 400);

  const fotoItem = p.locator('[data-testid="stepItem profilePhoto"]').first();
  if (await fotoItem.isVisible({ timeout: 3000 }).catch(() => false)) {
    const box = await fotoItem.boundingBox().catch(() => null);
    if (box) await humanMouseMove(p, box.x + box.width * randFloat(0.2, 0.8), box.y + box.height * randFloat(0.2, 0.8));
    await humanPause(randInt(sp(100), sp(200)));
    await fotoItem.click({ force: true, timeout: 4000 });
    log('info', 'Navegando para etapa de foto do perfil', cycle);
    await humanPause(randInt(sp(300), sp(600)));
    return true;
  }

  log('warn', 'Item "Foto do perfil" nao encontrado no hub', cycle);
  return false;
}

// ─── Tela de foto do perfil ───────────────────────────────────────────────────

async function tratarTelaFotoPerfil(p: Page, cycle: number): Promise<boolean> {
  const isFotoStep =
    await p.locator('[data-testid="step profilePhoto"]').isVisible({ timeout: 1500 }).catch(() => false);
  if (!isFotoStep) return false;

  log('info', 'Tela de foto do perfil detectada — clicando Tirar foto', cycle);
  await cogPause(200, 500);

  const btnFoto = p.locator('[data-testid="docUploadButton"]').first();
  if (await btnFoto.isVisible({ timeout: 3000 }).catch(() => false)) {
    const box = await btnFoto.boundingBox().catch(() => null);
    if (box) await humanMouseMove(p, box.x + box.width * randFloat(0.3, 0.7), box.y + box.height * randFloat(0.3, 0.7));
    await humanPause(randInt(sp(100), sp(220)));
    await btnFoto.click({ force: true, timeout: 4000 });
    log('info', 'Botao "Tirar foto" clicado', cycle);
    await humanPause(randInt(sp(300), sp(600)));
    return true;
  }

  const btnTexto = p.locator('button', { hasText: /Tirar foto/i }).first();
  if (await btnTexto.isVisible({ timeout: 1000 }).catch(() => false)) {
    await btnTexto.click({ force: true, timeout: 4000 });
    log('info', 'Botao "Tirar foto" clicado (fallback texto)', cycle);
    await humanPause(randInt(sp(300), sp(600)));
    return true;
  }

  log('warn', 'Botao "Tirar foto" nao encontrado', cycle);
  return false;
}

// ─── Tela de senha isolada pós-email ─────────────────────────────────────────

async function tratarTelaSenhaFluxo(
  p: Page,
  email: string,
  senha: string,
  cycle: number
): Promise<boolean> {
  const temSenha = await p.locator('#PASSWORD, input[autocomplete="new-password"], input[type="password"]')
    .first().isVisible({ timeout: 1000 }).catch(() => false);
  if (!temSenha) return false;

  // FIX A: se o input de cidade ainda está visível, NÃO tratar como tela de senha.
  const cidadeAindaVisivel = await p.locator(
    '[data-testid="flow-type-city-selector-v2-input"]'
  ).first().isVisible({ timeout: 300 }).catch(() => false);
  if (cidadeAindaVisivel) {
    log('info', '[tratarTelaSenhaFluxo] Input de cidade visivel — ignorando campo password (autofill)', cycle);
    return false;
  }

  const usernameVisivel = await p.locator('#username, input[id="username"]')
    .first().isVisible({ timeout: 400 }).catch(() => false);

  if (usernameVisivel) return false;

  const temUsernameAttached = await p.locator('#username, input[id="username"]')
    .count().then((n) => n > 0).catch(() => false);

  log('info', 'Tela de senha do fluxo detectada (pos-email)', cycle);
  await cogPause(200, 400);

  if (temUsernameAttached) {
    await forcarValorReact(p, '#username', email);
    log('info', '[senha-fluxo] Username hidden preenchido via React setter', cycle);
    await humanPause(randInt(sp(60), sp(100)));
  }

  const senhaSels = [
    '#PASSWORD',
    'input[autocomplete="new-password"]',
    'input[autocomplete="current-password"]',
    'input[name="password"]',
    'input[type="password"]',
  ];

  for (const sel of senhaSels) {
    if (await p.locator(sel).first().isVisible({ timeout: 1000 }).catch(() => false)) {
      await p.locator(sel).evaluate((el: HTMLInputElement) => {
        const nativeSet = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
        if (nativeSet) nativeSet.call(el, '');
        else el.value = '';
        el.dispatchEvent(new InputEvent('input', { bubbles: true, cancelable: false, composed: true, data: '', inputType: 'deleteContentBackward' }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      }).catch(() => {});
      await humanPause(randInt(sp(40), sp(80)));

      await forcarValorReact(p, sel, senha);
      await humanPause(randInt(sp(50), sp(100)));
      await humanTypeForce(p, sel, senha);

      const val = await p.locator(sel).inputValue().catch(() => '');
      if (val !== senha) {
        log('warn', '[senha-fluxo] Valor incorreto apos digitacao — re-forcando', cycle);
        await forcarValorReact(p, sel, senha);
        await humanPause(randInt(sp(100), sp(200)));
      }

      const fwdBtn = p.locator('#forward-button, [data-testid="forward-button"]').first();
      const habilitado = await fwdBtn.waitFor({ state: 'visible', timeout: 1500 })
        .then(() => fwdBtn.isEnabled({ timeout: 1500 }))
        .catch(() => false);
      if (!habilitado) {
        log('warn', '[senha-fluxo] forward-button ainda disabled — disparando blur', cycle);
        await p.locator(sel).evaluate((el) => {
          el.dispatchEvent(new FocusEvent('blur', { bubbles: true }));
        }).catch(() => {});
        await humanPause(randInt(sp(150), sp(300)));
      }

      log('info', `[senha-fluxo] Senha digitada (${sel})`, cycle);
      break;
    }
  }

  await cogPause(200, 400);
  await clickForwardButton(p, cycle);
  log('info', '[senha-fluxo] Avancado apos senha', cycle);
  await humanPause(randInt(sp(300), sp(600)));
  return true;
}

// ─── Tela de re-autenticação com username + password VISÍVEIS ─────────────────

async function tratarTelaReAuth(
  p: Page,
  email: string,
  senha: string,
  cycle: number
): Promise<boolean> {
  const temEmail = await p.locator('#username, input[id="username"]')
    .first().isVisible({ timeout: 1000 }).catch(() => false);
  const temSenha = await p.locator('#PASSWORD, input[autocomplete="new-password"], input[type="password"]')
    .first().isVisible({ timeout: 1000 }).catch(() => false);

  if (!temEmail || !temSenha) return false;

  // FIX A: mesma guarda — se cidade visível, não é tela de re-auth
  const cidadeAindaVisivelReAuth = await p.locator(
    '[data-testid="flow-type-city-selector-v2-input"]'
  ).first().isVisible({ timeout: 300 }).catch(() => false);
  if (cidadeAindaVisivelReAuth) {
    log('info', '[tratarTelaReAuth] Input de cidade visivel — ignorando re-auth (autofill)', cycle);
    return false;
  }

  log('info', 'Tela re-auth detectada (username + password visiveis)', cycle);
  await cogPause(200, 400);

  const emailSel = '#username';

  await p.locator(emailSel).evaluate((el: HTMLInputElement) => {
    const nativeSet = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
    if (nativeSet) nativeSet.call(el, '');
    else el.value = '';
    el.dispatchEvent(new InputEvent('input', { bubbles: true, cancelable: false, composed: true, data: '', inputType: 'deleteContentBackward' }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }).catch(() => {});
  await humanPause(randInt(sp(40), sp(80)));

  await forcarValorReact(p, emailSel, email);
  await humanPause(randInt(sp(50), sp(100)));
  await humanTypeForce(p, emailSel, email);

  const emailVal = await p.locator(emailSel).inputValue().catch(() => '');
  if (emailVal !== email) {
    log('warn', '[re-auth] Email incorreto apos digitacao — re-forcando', cycle);
    await forcarValorReact(p, emailSel, email);
    await humanPause(randInt(sp(100), sp(200)));
  }

  await p.locator(emailSel).evaluate((el) => {
    el.dispatchEvent(new FocusEvent('blur', { bubbles: true }));
  }).catch(() => {});
  await humanPause(randInt(sp(100), sp(200)));

  log('info', `[re-auth] Email: "${await p.locator(emailSel).inputValue().catch(() => '')}"`, cycle);

  const senhaSels = ['#PASSWORD', 'input[autocomplete="new-password"]', 'input[autocomplete="current-password"]', 'input[type="password"]'];
  let senhaSel = '';

  for (const sel of senhaSels) {
    if (await p.locator(sel).first().isVisible({ timeout: 1000 }).catch(() => false)) {
      senhaSel = sel;

      await p.locator(sel).evaluate((el: HTMLInputElement) => {
        const nativeSet = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
        if (nativeSet) nativeSet.call(el, '');
        else el.value = '';
        el.dispatchEvent(new InputEvent('input', { bubbles: true, cancelable: false, composed: true, data: '', inputType: 'deleteContentBackward' }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      }).catch(() => {});
      await humanPause(randInt(sp(40), sp(80)));

      await forcarValorReact(p, sel, senha);
      await humanPause(randInt(sp(50), sp(100)));
      await humanTypeForce(p, sel, senha);

      const senhaVal = await p.locator(sel).inputValue().catch(() => '');
      if (senhaVal !== senha) {
        log('warn', '[re-auth] Senha incorreta apos digitacao — re-forcando', cycle);
        await forcarValorReact(p, sel, senha);
        await humanPause(randInt(sp(100), sp(200)));
      }

      await p.locator(sel).evaluate((el) => {
        el.dispatchEvent(new FocusEvent('blur', { bubbles: true }));
      }).catch(() => {});
      await humanPause(randInt(sp(100), sp(200)));

      log('info', `[re-auth] Senha digitada (${sel})`, cycle);
      break;
    }
  }

  const fwdBtn = p.locator('#forward-button, [data-testid="forward-button"]').first();

  let habilitado = false;
  for (let tentativa = 1; tentativa <= 3; tentativa++) {
    habilitado = await fwdBtn.waitFor({ state: 'visible', timeout: 3000 })
      .then(() => fwdBtn.isEnabled({ timeout: 3000 }))
      .catch(() => false);

    if (habilitado) break;

    log('warn', `[re-auth] forward-button ainda disabled (tentativa ${tentativa}/3) — re-forcando valores`, cycle);

    await forcarValorReact(p, emailSel, email);
    if (senhaSel) {
      await forcarValorReact(p, senhaSel, senha);
      await p.locator(senhaSel).evaluate((el) => {
        el.dispatchEvent(new FocusEvent('blur', { bubbles: true }));
      }).catch(() => {});
    }
    await humanPause(randInt(sp(200), sp(400)));
  }

  if (!habilitado) {
    log('warn', '[re-auth] forward-button nunca habilitou — tentando clicar de qualquer forma', cycle);
  }

  await cogPause(150, 300);

  const submitSels = [
    '#forward-button',
    '[data-testid="forward-button"]',
    'button[type="submit"]',
    'button:has-text("Continuar")',
    'button:has-text("Continue")',
    'button:has-text("Entrar")',
    'button:has-text("Sign in")',
  ];

  for (const sel of submitSels) {
    const el = p.locator(sel).first();
    if (await el.isVisible({ timeout: 1000 }).catch(() => false)) {
      const box = await el.boundingBox().catch(() => null);
      if (box) await humanMouseMove(p, box.x + box.width * randFloat(0.3, 0.7), box.y + box.height * randFloat(0.3, 0.7));
      await humanPause(randInt(sp(80), sp(180)));
      await el.click({ force: true, timeout: 4000 });
      log('info', `[re-auth] Botao submit clicado (${sel})`, cycle);
      await humanPause(randInt(sp(500), sp(900)));
      return true;
    }
  }

  log('warn', '[re-auth] Nenhum botao de submit encontrado', cycle);
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
    log('info', 'Browser iniciado');
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
  if (ctx) { await ctx.close().catch(() => {}); contextosPorCiclo.delete(cycle); }
}

// ─── Etapas do flow ───────────────────────────────────────────────────────────

async function forcarValorReact(p: Page, selector: string, value: string): Promise<void> {
  await p.locator(selector).evaluate((el: HTMLInputElement, val: string) => {
    const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype, 'value'
    )?.set;
    if (nativeInputValueSetter) {
      nativeInputValueSetter.call(el, val);
    } else {
      el.value = val;
    }
    el.dispatchEvent(new InputEvent('input',  { bubbles: true, cancelable: false, composed: true, data: val, inputType: 'insertText' }));
    el.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));
  }, value).catch(() => {});
}

async function etapa_digitarEmailOuTelefone(p: Page, email: string, cycle: number): Promise<void> {
  log('info', `Digitando email: ${email}`, cycle);

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
    const visible = await p.locator(SEL).first().isVisible({ timeout: 3000 }).catch(() => false);
    if (visible) {
      log('info', `[DEBUG] Campo "${SEL}" -> "${email}"`, cycle);

      await p.locator(SEL).evaluate((el: HTMLInputElement) => {
        const nativeSet = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
        if (nativeSet) nativeSet.call(el, '');
        else el.value = '';
        el.dispatchEvent(new InputEvent('input', { bubbles: true, cancelable: false, composed: true, data: '', inputType: 'deleteContentBackward' }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      }).catch(() => {});
      await humanPause(randInt(sp(40), sp(80)));

      await humanTypeForce(p, SEL, email);

      const val = await p.locator(SEL).inputValue().catch(() => '');
      if (val !== email) {
        log('warn', `Valor pos-digitacao "${val}" != email esperado — forcando via React setter`, cycle);
        await forcarValorReact(p, SEL, email);
        await humanPause(randInt(sp(100), sp(200)));
      }

      const finalVal = await p.locator(SEL).inputValue().catch(() => '');
      log('info', `Email digitado — valor final: "${finalVal}"`, cycle);
      return;
    }
  }

  throw new Error('Campo de email/telefone nao encontrado em nenhum seletor conhecido');
}

async function etapa_digitarSenha(p: Page, senha: string, cycle: number): Promise<void> {
  log('info', 'Digitando senha...', cycle);

  const SELS = [
    '#PASSWORD',
    'input[autocomplete="new-password"]',
    'input[autocomplete="current-password"]',
    'input[name="password"]',
    'input[type="password"]',
  ];

  for (const SEL of SELS) {
    const visible = await p.locator(SEL).first().isVisible({ timeout: 3000 }).catch(() => false);
    if (visible) {
      log('info', `Campo senha encontrado: "${SEL}"`, cycle);

      await p.locator(SEL).evaluate((el: HTMLInputElement) => {
        const nativeSet = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
        if (nativeSet) nativeSet.call(el, '');
        else el.value = '';
        el.dispatchEvent(new InputEvent('input', { bubbles: true, cancelable: false, composed: true, data: '', inputType: 'deleteContentBackward' }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      }).catch(() => {});
      await humanPause(randInt(sp(40), sp(80)));

      await forcarValorReact(p, SEL, senha);
      await humanPause(randInt(sp(50), sp(100)));

      await humanTypeForce(p, SEL, senha);

      const val = await p.locator(SEL).inputValue().catch(() => '');
      if (val !== senha) {
        log('warn', 'Valor pos-digitacao da senha incorreto — forcando via React setter', cycle);
        await forcarValorReact(p, SEL, senha);
        await humanPause(randInt(sp(100), sp(200)));
      }

      const fwdBtn = p.locator('#forward-button, [data-testid="forward-button"]').first();
      const habilitado = await fwdBtn.waitFor({ state: 'visible', timeout: 1500 })
        .then(() => fwdBtn.isEnabled({ timeout: 1500 }))
        .catch(() => false);
      if (!habilitado) {
        log('warn', '#forward-button ainda disabled apos senha — disparando blur para forcar validacao React', cycle);
        await p.locator(SEL).evaluate((el) => {
          el.dispatchEvent(new FocusEvent('blur', { bubbles: true }));
        }).catch(() => {});
        await humanPause(randInt(sp(150), sp(250)));
      }

      log('info', 'Senha digitada', cycle);
      return;
    }
  }

  throw new Error('Campo de senha nao encontrado');
}

async function etapa_aguardarOTP(
  p: Page, emailClient: IEmailClient, email: string,
  cycle: number, otpTimeoutMs = 60_000
): Promise<string> {
  log('info', 'Aguardando OTP no email...', cycle);
  const otp = await emailClient.waitForOTP(email, otpTimeoutMs, cycle);
  log('success', `OTP recebido: ${otp}`, cycle);
  return otp;
}

async function etapa_digitarOTP(p: Page, otp: string, cycle: number): Promise<void> {
  log('info', `Digitando OTP: ${otp}`, cycle);

  const primeroCampoUber = p.locator('#EMAIL_OTP_CODE-0');
  if (await primeroCampoUber.isVisible({ timeout: 3000 }).catch(() => false)) {
    log('info', 'OTP em campos individuais EMAIL_OTP_CODE-N', cycle);
    for (let i = 0; i < otp.length; i++) {
      const campo = p.locator(`#EMAIL_OTP_CODE-${i}`);
      await campo.waitFor({ state: 'visible', timeout: 3000 }).catch(() => {});
      await focusField(p, `#EMAIL_OTP_CODE-${i}`);
      await humanPause(randInt(sp(40), sp(80)));
      await _typeChar(p, otp[i]!, isSpeedMode());
      await humanPause(randInt(sp(50), sp(100)));
    }
    log('info', 'OTP digitado (EMAIL_OTP_CODE-N)', cycle);
    return;
  }

  const camposOtp = p.locator('input[autocomplete="one-time-code"]');
  const totalOtp = await camposOtp.count().catch(() => 0);
  if (totalOtp >= 2) {
    log('info', `OTP em ${totalOtp} campos autocomplete=one-time-code`, cycle);
    for (let i = 0; i < Math.min(totalOtp, otp.length); i++) {
      const campo = camposOtp.nth(i);
      await campo.waitFor({ state: 'visible', timeout: 2000 }).catch(() => {});
      const box = await campo.boundingBox().catch(() => null);
      if (box) await humanMouseMove(p, box.x + box.width / 2, box.y + box.height / 2);
      await campo.click({ timeout: 2000 }).catch(() => {});
      await humanPause(randInt(sp(40), sp(80)));
      await _typeChar(p, otp[i]!, isSpeedMode());
      await humanPause(randInt(sp(50), sp(100)));
    }
    log('info', 'OTP digitado (autocomplete individual)', cycle);
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
    if (await p.locator(sel).first().isVisible({ timeout: 1500 }).catch(() => false)) {
      const count = await p.locator(sel).count();
      if (count >= 2) {
        log('info', `OTP em ${count} campos "${sel}"`, cycle);
        for (let i = 0; i < Math.min(count, otp.length); i++) {
          const campo = p.locator(sel).nth(i);
          await campo.waitFor({ state: 'visible', timeout: 2000 }).catch(() => {});
          await campo.click({ timeout: 2000 }).catch(() => {});
          await humanPause(randInt(sp(40), sp(80)));
          await _typeChar(p, otp[i]!, isSpeedMode());
          await humanPause(randInt(sp(50), sp(90)));
        }
        log('info', 'OTP digitado (multiplos campos fallback)', cycle);
        return;
      }
      await humanTypeForce(p, sel, otp);
      log('info', 'OTP digitado (campo unico)', cycle);
      return;
    }
  }

  throw new Error('Campo de OTP nao encontrado');
}

async function aguardarNavegacaoEstabilizar(p: Page, maxWaitMs = 6_000, stableMs = 600): Promise<string> {
  const fim = Date.now() + maxWaitMs;
  let lastUrl = p.url();
  let lastChange = Date.now();
  while (Date.now() < fim) {
    await humanPause(150);
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
      const visible = await el.isVisible({ timeout: 1000 }).catch(() => false);
      if (!visible) continue;

      const val = await el.inputValue().catch(() => '');
      if (val) {
        log('info', `[telefone] Campo "${sel}" ja preenchido: "${val}"`, cycle);
        return true;
      }

      log('info', `Preenchendo telefone "${telefone}" em "${sel}"`, cycle);
      await humanTypeForce(p, sel, telefone);
      log('info', 'Telefone preenchido', cycle);
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
  log('info', `[Tela ${telaIdx}] Verificando tela de onboarding...`, cycle);

  await dispensarCookies(p);

  if (await detectarVeriff(p)) {
    log('warn', `[Tela ${telaIdx}] KYC Veriff detectado — encerrando ciclo`, cycle);
    throw new Error('VERIFF_DETECTED');
  }

  // FIX A: verificar cidade PRIMEIRO, antes de tratarTelaSenha/ReAuth.
  const INPUT_CIDADE_SEL = '[data-testid="flow-type-city-selector-v2-input"]';
  if (await p.locator(INPUT_CIDADE_SEL).first().isVisible({ timeout: 1000 }).catch(() => false)) {
    const urlAntesCidade = p.url();
    await selecionarCidade(p, payload.cidade, cycle);

    log('info', `[Tela ${telaIdx}] Aguardando Uber avancar apos cidade...`, cycle);
    const fimEspera = Date.now() + 4_000;
    let cidadeAindaVisivel = true;
    let urlPosCidade = p.url();
    while (Date.now() < fimEspera) {
      await humanPause(200);
      urlPosCidade = p.url();
      cidadeAindaVisivel = await p.locator(INPUT_CIDADE_SEL).first().isVisible({ timeout: 200 }).catch(() => false);
      if (!cidadeAindaVisivel || urlPosCidade !== urlAntesCidade) break;
    }

    if (urlPosCidade !== urlAntesCidade) {
      log('info', `[Tela ${telaIdx}] Uber navegou apos cidade: ${urlPosCidade}`, cycle);
      await preencherInviteCode(p, payload.inviteCode, cycle);
      return true;
    }
    if (!cidadeAindaVisivel) {
      log('info', `[Tela ${telaIdx}] Input de cidade sumiu — tela avancou internamente`, cycle);
      await preencherInviteCode(p, payload.inviteCode, cycle);
    } else {
      await preencherInviteCode(p, payload.inviteCode, cycle);
    }

    await cogPause(150, 300);
    const aceitouAposCidade = await tentarAceitarTermos(p, cycle);
    if (aceitouAposCidade) await cogPause(150, 300);

    await dispensarCookies(p);
    const isTelaSenhaAposCidade = await p.locator(
      '#PASSWORD, input[autocomplete="new-password"], input[type="password"]'
    ).first().isVisible({ timeout: 600 }).catch(() => false);
    const cidadeAindaVisivelFinal = await p.locator(INPUT_CIDADE_SEL).first().isVisible({ timeout: 300 }).catch(() => false);
    if (isTelaSenhaAposCidade && !cidadeAindaVisivelFinal) {
      log('warn', `[Tela ${telaIdx}] Tela de senha apos cidade — delegando`, cycle);
      await tratarTelaSenhaFluxo(p, payload.email, payload.senha, cycle);
      return true;
    }

    await clickForwardButton(p, cycle);
    log('info', `[Tela ${telaIdx}] Botao de avancar clicado (pos-cidade)`, cycle);
    return true;
  }

  if (await tratarTelaWhatsApp(p, cycle)) return true;
  if (await tratarHubKYC(p, cycle)) return true;
  if (await tratarTelaFotoPerfil(p, cycle)) return true;
  if (await tratarTelaSenhaFluxo(p, payload.email, payload.senha, cycle)) return true;
  if (await tratarTelaReAuth(p, payload.email, payload.senha, cycle)) return true;

  try {
    const inputs = await p.$$eval('input:not([type="hidden"])', (els) =>
      els.map((el) => {
        const e = el as HTMLInputElement;
        return `${e.tagName}[type=${e.type}][id=${e.id}][autocomplete=${e.autocomplete}][placeholder=${e.placeholder}]`;
      })
    );
    if (inputs.length > 0) {
      log('info', `[Tela ${telaIdx}] Inputs: ${inputs.slice(0, 6).join(' | ')}`, cycle);
    }
  } catch { /* ignora */ }

  let fezAlgo = false;

  const nomeSels = ['#FIRST_NAME', '[autocomplete="given-name"]', '[data-testid*="first-name"]', '[name="firstName"]', '[id*="first"]', '[placeholder*="rimeiro"]'];
  for (const sel of nomeSels) {
    if (await p.locator(sel).first().isVisible({ timeout: 1000 }).catch(() => false)) {
      const val = await p.locator(sel).first().inputValue().catch(() => '');
      if (!val) {
        await humanTypeForce(p, sel, payload.nome);
        log('info', `[Tela ${telaIdx}] Nome preenchido (${sel})`, cycle);
        fezAlgo = true;
      }
      break;
    }
  }

  await humanPause(randInt(sp(80), sp(160)));

  const sobreSels = ['#LAST_NAME', '[autocomplete="family-name"]', '[data-testid*="last-name"]', '[name="lastName"]', '[id*="last"]', '[placeholder*="obrenome"]'];
  for (const sel of sobreSels) {
    if (await p.locator(sel).first().isVisible({ timeout: 1000 }).catch(() => false)) {
      const val = await p.locator(sel).first().inputValue().catch(() => '');
      if (!val) {
        await humanTypeForce(p, sel, payload.sobrenome);
        log('info', `[Tela ${telaIdx}] Sobrenome preenchido (${sel})`, cycle);
        fezAlgo = true;
      }
      break;
    }
  }

  await humanPause(randInt(sp(80), sp(160)));

  const telefonePreenchido = await preencherTelefone(p, payload.telefone, cycle);
  if (telefonePreenchido) {
    fezAlgo = true;
    await cogPause(300, 600);
  }

  await humanPause(randInt(sp(80), sp(160)));

  await cogPause(150, 350);

  // FIX B: tentarAceitarTermos agora recebe cycle para logging e usa estratégia
  // multicamada com verificação de checked + fallback JS setter
  const aceitou = await tentarAceitarTermos(p, cycle);
  if (aceitou) { fezAlgo = true; await cogPause(200, 400); }

  const temBotao = await p.locator(
    '#forward-button, [data-testid="forward-button"], [data-testid="submit-button"], button[type="submit"]'
  ).first().isVisible({ timeout: 1000 }).catch(() => false);

  if (!fezAlgo && !temBotao) {
    log('info', `[Tela ${telaIdx}] Tela de transicao sem campos/botao — aguardando navegacao automatica...`, cycle);
    return false;
  }

  await dispensarCookies(p);
  const isTelaSenha = await p.locator(
    '#PASSWORD, input[autocomplete="new-password"], input[type="password"]'
  ).first().isVisible({ timeout: 600 }).catch(() => false);
  if (isTelaSenha) {
    log('warn', `[Tela ${telaIdx}] Tela de senha detectada antes do forward — delegando para tratarTelaSenhaFluxo`, cycle);
    await tratarTelaSenhaFluxo(p, payload.email, payload.senha, cycle);
    return true;
  }

  await clickForwardButton(p, cycle);
  log('info', `[Tela ${telaIdx}] Botao de avancar clicado`, cycle);
  return true;
}

// ─── etapa_posEmail com stall-guard por etapa ─────────────────────────────────

async function etapa_posEmail(
  p: Page,
  payload: { nome: string; sobrenome: string; cidade: string; telefone: string; inviteCode: string; email: string; senha: string },
  cycle: number
): Promise<'success' | 'onboarding' | 'unknown'> {
  const MAX_TELAS = 15;
  const MAX_TELA_TIMEOUT_MS = 10_000;

  for (let tela = 1; tela <= MAX_TELAS; tela++) {
    const stallController = new AbortController();
    const stallTimer = setTimeout(() => {
      log('error', `[Tela ${tela}] Etapa travada por mais de ${STEP_STALL_TIMEOUT_MS / 60000} minutos — abortando ciclo`, cycle);
      stallController.abort();
      fecharContextoCiclo(cycle).catch(() => {});
    }, STEP_STALL_TIMEOUT_MS);

    try {
      const url = await aguardarNavegacaoEstabilizar(p, MAX_TELA_TIMEOUT_MS, 600);
      log('info', `[Tela ${tela}] URL: ${url}`, cycle);

      if (isSuccessUrl(url)) {
        log('success', `Destino final detectado! URL: ${url}`, cycle);
        clearTimeout(stallTimer);
        return 'success';
      }

      if (isVeriffUrl(url) || await detectarVeriff(p)) {
        log('warn', `[Tela ${tela}] KYC Veriff detectado no loop principal — encerrando`, cycle);
        clearTimeout(stallTimer);
        throw new Error('VERIFF_DETECTED');
      }

      const isHubOrFoto =
        await p.locator('[data-testid="hub"], [data-testid="step profilePhoto"]')
          .first().isVisible({ timeout: 1500 }).catch(() => false);
      if (isHubOrFoto) {
        log('success', 'Hub/Foto detectado — conta criada com sucesso', cycle);
        clearTimeout(stallTimer);
        return 'success';
      }

      if (!isOnboardingUrl(url)) {
        log('warn', `URL nao reconhecida: ${url}`, cycle);
        clearTimeout(stallTimer);
        return 'unknown';
      }

      await p.waitForSelector(
        'input:not([type="hidden"]), button, [role="checkbox"], #forward-button, [data-testid="hub"], [data-testid="step whatsAppOptIn"], [data-testid="step profilePhoto"], [data-testid="submit-button"]',
        { timeout: 6_000 }
      ).catch(() => {});

      const clicou = await processarTelaOnboarding(p, payload, cycle, tela);

      if (!clicou) {
        const urlApos = await aguardarNavegacaoEstabilizar(p, 4_000, 1_000);
        if (urlApos === url) {
          log('warn', `[Tela ${tela}] URL nao avancou. Abortando loop.`, cycle);
          clearTimeout(stallTimer);
          return isSuccessUrl(urlApos) ? 'success' : 'onboarding';
        }
      }
    } finally {
      clearTimeout(stallTimer);
    }
  }

  log('warn', `Loop de onboarding atingiu limite de ${MAX_TELAS} telas`, cycle);
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
    page.setDefaultTimeout(20_000);

    const emailClient: IEmailClient = createEmailClient(opts.emailProvider as any, opts.tempMailApiKey);
    const emailAccount = await emailClient.createRandomEmail();
    log('info', `Email criado: ${emailAccount.email}`, cycle);

    const payload = gerarPayloadCompleto(emailAccount, opts.inviteCode);

    log('info', `Navegando para ${opts.cadastroUrl}`, cycle);
    await page.goto(opts.cadastroUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await humanPause(randInt(sp(400), sp(800)));
    await dispensarCookies(page);
    await pageWarmup(page, cycle);

    const isTelaCampoInicial = await page.locator(
      '#PHONE_NUMBER_or_EMAIL_ADDRESS, #EMAIL_ADDRESS, input[type="email"], input[autocomplete="email"]'
    ).first().isVisible({ timeout: 10000 }).catch(() => false);

    if (!isTelaCampoInicial) {
      log('warn', 'Tela inicial nao detectada — tentando loop de onboarding direto', cycle);
      const resultado = await etapa_posEmail(
        page,
        { nome: payload.nome, sobrenome: payload.sobrenome, cidade: payload.cidade, telefone: payload.telefone, inviteCode: opts.inviteCode, email: payload.email, senha: payload.senha },
        cycle
      );
      if (resultado !== 'success') log('warn', `Flow incompleto (sem tela inicial). URL: ${page.url()}`, cycle);
      return;
    }

    await etapa_digitarEmailOuTelefone(page, payload.email, cycle);
    await cogPause(200, 400);
    await clickForwardButton(page, cycle);
    await aguardarNavegacaoEstabilizar(page, 4_000, 600);

    const nomeVisiblePreSenha = await page.locator(
      '#FIRST_NAME, [autocomplete="given-name"]'
    ).first().isVisible({ timeout: 3000 }).catch(() => false);

    if (nomeVisiblePreSenha) {
      log('info', 'Tela de nome detectada antes da senha', cycle);
      const nomeSels = ['#FIRST_NAME', '[autocomplete="given-name"]', '[name="firstName"]'];
      for (const sel of nomeSels) {
        if (await page.locator(sel).first().isVisible({ timeout: 1000 }).catch(() => false)) {
          await humanTypeForce(page, sel, payload.nome); break;
        }
      }
      await humanPause(randInt(sp(150), sp(350)));
      const sobreSels = ['#LAST_NAME', '[autocomplete="family-name"]', '[name="lastName"]'];
      for (const sel of sobreSels) {
        if (await page.locator(sel).first().isVisible({ timeout: 1000 }).catch(() => false)) {
          await humanTypeForce(page, sel, payload.sobrenome); break;
        }
      }
      await cogPause(200, 400);
      await tentarAceitarTermos(page, cycle);
      await clickForwardButton(page, cycle);
      await aguardarNavegacaoEstabilizar(page, 4_000, 600);
    }

    const termosVisiblePreSenha = await page.locator('[data-testid="accept-terms"]').first()
      .isVisible({ timeout: 1500 }).catch(() => false);
    if (termosVisiblePreSenha) {
      await tentarAceitarTermos(page, cycle);
      await cogPause(200, 400);
      await clickForwardButton(page, cycle);
      await aguardarNavegacaoEstabilizar(page, 4_000, 600);
    }

    const senhaVisible = await page.locator(
      '#PASSWORD, input[autocomplete="new-password"], input[type="password"]'
    ).first().isVisible({ timeout: 5000 }).catch(() => false);

    if (senhaVisible) {
      log('info', 'Tela de senha detectada — fluxo de motorista (sem OTP)', cycle);
      await etapa_digitarSenha(page, payload.senha, cycle);
      await cogPause(200, 400);
      await clickForwardButton(page, cycle);
      await aguardarNavegacaoEstabilizar(page, 4_000, 600);
    }

    const otpVisible = await page.locator(
      '#EMAIL_OTP_CODE-0, input[autocomplete="one-time-code"], input[name="otpCode"], input[maxlength="1"]'
    ).first().isVisible({ timeout: 3000 }).catch(() => false);

    if (otpVisible) {
      log('info', 'OTP detectado (contexto de re-auth ou variante)', cycle);
      const otp = await etapa_aguardarOTP(page, emailClient, payload.email, cycle, opts.otpTimeout);
      await etapa_digitarOTP(page, otp, cycle);
      log('info', 'Aguardando navegacao automatica pos-OTP...', cycle);
      await aguardarNavegacaoEstabilizar(page, 5_000, 1_000);
    }

    const resultado = await etapa_posEmail(
      page,
      { nome: payload.nome, sobrenome: payload.sobrenome, cidade: payload.cidade, telefone: payload.telefone, inviteCode: opts.inviteCode, email: payload.email, senha: payload.senha },
      cycle
    );

    if (resultado === 'success') {
      const urlFinal = page.url();
      const cookiesRaw: Cookie[] = await ctx.cookies().catch(() => []);
      log('info', `${cookiesRaw.length} cookies capturados`, cycle);

      const tmScript = gerarTampermonkeyScript(cookiesRaw, payload.email);
      log('success', `Tampermonkey Script:\n${tmScript}`, cycle);

      log('success', `Conta criada com sucesso! URL: ${urlFinal}`, cycle);
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
      log('warn', `Conta NAO salva — fluxo incompleto. URL final: ${urlFinal}`, cycle);
    }

  } catch (err: any) {
    if (err?.message === 'VERIFF_DETECTED') {
      log('warn', `Ciclo ${cycle} encerrado: KYC Veriff detectado`, cycle);
    } else {
      log('error', `Erro no ciclo: ${err?.message ?? err}`, cycle);
      throw err;
    }
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
    await _executarCiclo(cycle, { cadastroUrl, ...opts });
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
    cadastroUrl: (config as any).cadastroUrl ?? 'https://www.uber.com/br/pt-br/drive/application/',
    emailProvider: emailProvider ?? config.emailProvider,
    tempMailApiKey: config.tempMailApiKey ?? '',
    otpTimeout: config.otpTimeout ?? 60_000,
    extraDelay: config.extraDelay ?? 0,
    inviteCode: config.inviteCode ?? '',
  });
}
