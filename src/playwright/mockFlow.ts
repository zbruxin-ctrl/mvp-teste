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

// ─── Speed helpers ────────────────────────────────────────────────────────────

function isSpeedMode(): boolean {
  return !!(globalState.getState().config as any)?.speedMode;
}

function sp(normal: number): number {
  return isSpeedMode() ? Math.max(530, Math.round(normal * 0.4) + 500) : normal;
}

// ─── Primitivas humanas ───────────────────────────────────────────────────────

function randInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function randFloat(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

async function humanPause(baseMs: number): Promise<void> {
  const effective = sp(baseMs);
  const jitter = randInt(-Math.floor(effective * 0.15), Math.floor(effective * 0.2));
  await new Promise<void>((r) => setTimeout(r, Math.max(30, effective + jitter)));
}

// Pausa com distribuição log-normal — imita pausas cognitivas humanas reais
async function cogPause(minMs: number, maxMs: number): Promise<void> {
  const base = randInt(minMs, maxMs);
  // 15% chance de pausa extra longa ("usuário distraído")
  const extra = Math.random() < 0.15 ? randInt(600, 1800) : 0;
  await humanPause(base + extra);
}

// ─── Movimento de mouse realista (curva Bézier cúbica + velocidade não-uniforme) ─

async function humanMouseMove(p: Page, x: number, y: number): Promise<void> {
  const fast = isSpeedMode();
  const startX = randInt(30, 360);
  const startY = randInt(80, 500);

  // Dois pontos de controle → curva cúbica mais orgânica
  const cp1X = startX + (x - startX) * randFloat(0.2, 0.4) + randInt(-30, 30);
  const cp1Y = startY + (y - startY) * randFloat(0.2, 0.4) + randInt(-20, 20);
  const cp2X = startX + (x - startX) * randFloat(0.6, 0.8) + randInt(-20, 20);
  const cp2Y = startY + (y - startY) * randFloat(0.6, 0.8) + randInt(-15, 15);

  const totalSteps = fast ? randInt(6, 10) : randInt(14, 22);

  for (let i = 0; i <= totalSteps; i++) {
    const rawT = i / totalSteps;
    // Ease-in-out cúbica — lento no início e no fim, rápido no meio
    const t = rawT < 0.5
      ? 4 * rawT * rawT * rawT
      : 1 - Math.pow(-2 * rawT + 2, 3) / 2;

    const bx = Math.round(
      Math.pow(1 - t, 3) * startX +
      3 * Math.pow(1 - t, 2) * t * cp1X +
      3 * (1 - t) * t * t * cp2X +
      t * t * t * x
    );
    const by = Math.round(
      Math.pow(1 - t, 3) * startY +
      3 * Math.pow(1 - t, 2) * t * cp1Y +
      3 * (1 - t) * t * t * cp2Y +
      t * t * t * y
    );

    await p.mouse.move(bx, by);

    // Velocidade não-uniforme via sin: mais devagar no início/fim
    const speedFactor = Math.sin(Math.PI * rawT);
    const stepDelay = fast
      ? Math.max(2, Math.round(5 * (1 - speedFactor * 0.7)))
      : Math.max(4, Math.round(randInt(8, 18) * (1 - speedFactor * 0.6)));
    await new Promise<void>((r) => setTimeout(r, stepDelay));
  }

  // Micro-tremor pós-chegada (mão humana não para instantaneamente)
  if (!fast) {
    for (let j = 0; j < randInt(1, 3); j++) {
      await p.mouse.move(x + randInt(-2, 2), y + randInt(-2, 2));
      await new Promise<void>((r) => setTimeout(r, randInt(30, 80)));
    }
    await p.mouse.move(x, y);
  }
}

// ─── Scroll idle — simula usuário lendo a página antes de interagir ───────────

async function scrollIdle(p: Page): Promise<void> {
  if (isSpeedMode()) return;
  const amount = randInt(40, 180);
  await humanPause(randInt(400, 900));
  await p.mouse.wheel(0, amount);
  await humanPause(randInt(300, 700));
  await p.mouse.wheel(0, -amount);
  await humanPause(randInt(200, 500));
}

// ─── Hover realista antes de clicar ──────────────────────────────────────────

async function hoverElement(p: Page, selector: string): Promise<void> {
  try {
    const box = await p.locator(selector).boundingBox().catch(() => null);
    if (!box) return;
    const nearX = Math.round(box.x + box.width * randFloat(0.3, 0.7));
    const nearY = Math.round(box.y + box.height * randFloat(0.3, 0.7));
    await humanMouseMove(p, nearX, nearY);
    // Hover dwell: usuário olha antes de clicar
    await humanPause(randInt(sp(180), sp(380)));
  } catch { /* ignora */ }
}

// ─── Digitação humana ─────────────────────────────────────────────────────────

async function humanType(p: Page, selector: string, value: string): Promise<void> {
  await p.waitForSelector(selector, { state: 'visible', timeout: 15000 });
  await hoverElement(p, selector);
  await p.click(selector);
  await p.fill(selector, '');
  await humanPause(randInt(sp(60), sp(150)));
  const fast = isSpeedMode();
  for (let i = 0; i < value.length; i++) {
    const ch = value[i]!;
    if (!fast && Math.random() < 0.03 && /[a-zA-Z]/.test(ch)) {
      const typo = String.fromCharCode(ch.charCodeAt(0) + (Math.random() > 0.5 ? 1 : -1));
      await p.keyboard.type(typo, { delay: randInt(40, 80) });
      await humanPause(randInt(50, 120));
      await p.keyboard.press('Backspace');
      await humanPause(randInt(40, 90));
    }
    const charDelay = fast ? randInt(15, 40) : randInt(40, 100);
    await p.keyboard.type(ch, { delay: charDelay });
    if (!fast) {
      if (ch === ' ' || ch === '@' || ch === '.') await humanPause(randInt(90, 220));
      else if (Math.random() < 0.06) await humanPause(randInt(120, 350));
    }
  }
}

async function humanTypeForce(p: Page, selector: string, value: string): Promise<void> {
  await p.waitForSelector(selector, { state: 'visible', timeout: 15000 });
  await hoverElement(p, selector);
  await p.click(selector, { force: true });
  await humanPause(randInt(sp(80), sp(160)));
  await p.keyboard.press('ControlOrMeta+a');
  await humanPause(randInt(30, 60));
  await p.keyboard.press('Delete');
  await humanPause(randInt(sp(60), sp(150)));
  const currentVal = await p.locator(selector).inputValue().catch(() => '');
  if (currentVal.length > 0) {
    await p.click(selector, { clickCount: 3 });
    await humanPause(randInt(30, 60));
    for (let i = 0; i < currentVal.length; i++) {
      await p.keyboard.press('Backspace');
    }
    await humanPause(randInt(30, 60));
  }
  const fast = isSpeedMode();
  for (let i = 0; i < value.length; i++) {
    const ch = value[i]!;
    if (!fast && Math.random() < 0.03 && /[a-zA-Z]/.test(ch)) {
      const typo = String.fromCharCode(ch.charCodeAt(0) + (Math.random() > 0.5 ? 1 : -1));
      await p.keyboard.type(typo, { delay: randInt(40, 80) });
      await humanPause(randInt(50, 120));
      await p.keyboard.press('Backspace');
      await humanPause(randInt(40, 90));
    }
    const charDelay = fast ? randInt(15, 40) : randInt(40, 100);
    await p.keyboard.type(ch, { delay: charDelay });
    if (!fast) {
      if (ch === ' ' || ch === '@' || ch === '.') await humanPause(randInt(90, 220));
      else if (Math.random() < 0.06) await humanPause(randInt(120, 350));
    }
  }
  const finalVal = await p.locator(selector).inputValue().catch(() => '??');
  log('info', `🔍 [DEBUG] Campo "${selector}" após digitação: "${finalVal}"`);
}

// ─── Click humano (mouse.down + dwell + mouse.up) ──────────────────────────────

async function humanClick(p: Page, selector: string): Promise<void> {
  await p.waitForSelector(selector, { state: 'visible', timeout: 15000 });
  const box = await p.locator(selector).boundingBox();
  if (box) {
    const tx = Math.round(box.x + box.width * (0.25 + Math.random() * 0.5));
    const ty = Math.round(box.y + box.height * (0.25 + Math.random() * 0.5));
    await humanMouseMove(p, tx, ty);
    // Hover dwell crítico para Arkose — simula usuário avaliando o botão
    await humanPause(randInt(sp(120), sp(280)));
    await p.mouse.down();
    await humanPause(randInt(40, 120)); // duração do press — humano não é instantâneo
    await p.mouse.up();
  } else {
    await p.click(selector);
  }
}

// ─── Forward button: aguarda habilitado + pausa pensativa pré-clique ──────────

async function clickForwardButton(p: Page, cycle: number): Promise<void> {
  log('info', '⏳ Aguardando #forward-button habilitado...', cycle);
  await p.waitForSelector('#forward-button:not([disabled])', { state: 'visible', timeout: 15000 }).catch(async () => {
    log('warn', '⚠️ #forward-button:not([disabled]) não encontrado, tentando mesmo assim...', cycle);
  });
  // Pausa pensativa — como se o usuário revisasse o que digitou
  if (!isSpeedMode()) await cogPause(600, 1600);
  await humanClick(p, '#forward-button');
  log('info', '🖱️ #forward-button clicado', cycle);
}

// ─── Aquecimento de página — interações leves para construir histórico ────────
// O Arkose analisa o histórico de interação ANTES do clique no botão submit.
// Mover o mouse, scroll, focar elementos → aumenta score de humanidade.

async function pageWarmup(p: Page, cycle: number): Promise<void> {
  if (isSpeedMode()) {
    await humanPause(randInt(400, 800));
    return;
  }
  log('info', '🔥 Aquecendo página (simulando leitura)...', cycle);

  // 1. Movimentos de mouse aleatórios simulando leitura do formulário
  const pontos = [
    { x: randInt(80, 300), y: randInt(100, 250) },
    { x: randInt(50, 340), y: randInt(200, 380) },
    { x: randInt(100, 280), y: randInt(300, 500) },
  ];
  for (const pt of pontos) {
    await humanMouseMove(p, pt.x, pt.y);
    await humanPause(randInt(200, 500));
  }

  // 2. Scroll leve de leitura
  await scrollIdle(p);

  // 3. Hover no campo de email sem clicar — foco visual humano
  try {
    const inputBox = await p.locator('#PHONE_NUMBER_or_EMAIL_ADDRESS').boundingBox().catch(() => null);
    if (inputBox) {
      await humanMouseMove(p, inputBox.x + inputBox.width * 0.5, inputBox.y + inputBox.height * 0.5);
      await humanPause(randInt(300, 700));
      // Move para o botão e volta — padrão de hesitação humana
      const btnBox = await p.locator('#forward-button').boundingBox().catch(() => null);
      if (btnBox) {
        await humanMouseMove(p, btnBox.x + btnBox.width * 0.5, btnBox.y + btnBox.height * 0.5);
        await humanPause(randInt(200, 500));
        await humanMouseMove(p, inputBox.x + inputBox.width * 0.5, inputBox.y + inputBox.height * 0.5);
        await humanPause(randInt(300, 600));
      }
    }
  } catch { /* ignora */ }

  // 4. Pausa final "lendo o formulário"
  await cogPause(800, 2000);
  log('info', '✅ Aquecimento concluído', cycle);
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
        const box = await el.boundingBox().catch(() => null);
        if (box) {
          await humanMouseMove(p, box.x + box.width / 2, box.y + box.height / 2);
          await humanPause(randInt(sp(100), sp(200)));
        }
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
  const box = await p.locator(INPUT_SEL).boundingBox().catch(() => null);
  if (box) {
    await humanMouseMove(p, box.x + box.width / 2, box.y + box.height / 2);
    await humanPause(randInt(sp(80), sp(160)));
  }
  await p.click(INPUT_SEL);
  await p.fill(INPUT_SEL, '');
  await humanPause(randInt(sp(100), sp(200)));
  for (const ch of nomeBusca) {
    const charDelay = isSpeedMode() ? randInt(20, 50) : randInt(50, 110);
    await p.keyboard.type(ch, { delay: charDelay });
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
          await humanMouseMove(p, opcaoBox.x + opcaoBox.width / 2, opcaoBox.y + opcaoBox.height / 2);
          await humanPause(randInt(sp(150), sp(300)));
        }
        await opcao.click({ timeout: 5000 });
        log('info', `✅ Cidade selecionada: "${texto.trim()}"`, cycle);
        clicou = true;
        break;
      }
    } catch { /* tenta próxima */ }
  }

  if (!clicou) {
    log('warn', `⚠️ Nenhuma opção com "${nomeBusca}", clicando na primeira`, cycle);
    try {
      const primeiraBox = await opcoes.first().boundingBox().catch(() => null);
      if (primeiraBox) {
        await humanMouseMove(p, primeiraBox.x + primeiraBox.width / 2, primeiraBox.y + primeiraBox.height / 2);
        await humanPause(randInt(sp(150), sp(300)));
      }
      await opcoes.first().click({ timeout: 5000 });
    } catch {
      await p.keyboard.press('ArrowDown');
      await humanPause(randInt(sp(150), sp(300)));
      await p.keyboard.press('Enter');
    }
  }
  await humanPause(randInt(sp(400), sp(700)));
}

// ─── JS helpers ───────────────────────────────────────────────────────────────

const JS_NAO_ATIVAR = `
  (function() {
    var normalize = function(s) {
      return s.normalize('NFD').replace(/[\\u0300-\\u036f]/g, '').toUpperCase().trim();
    };
    var botoes = Array.from(document.querySelectorAll('button'));
    var alvo = botoes.find(function(b) {
      var t = normalize(b.innerText);
      return t.indexOf('NAO ATIVAR') !== -1 || t.indexOf('N AO ATIVAR') !== -1;
    });
    if (alvo) { alvo.click(); return true; }
    return false;
  })()
`;

const JS_FALLBACK_SUBMIT = `
  (function() {
    var normalize = function(s) {
      return s.normalize('NFD').replace(/[\\u0300-\\u036f]/g, '').toUpperCase().trim();
    };
    var botoes = Array.from(document.querySelectorAll('button[type="submit"]'));
    var alvo = botoes.find(function(b) {
      var t = normalize(b.innerText);
      return !t.includes('CONTINUAR') && !t.includes('AJUDA') && b.offsetParent !== null;
    });
    if (alvo) { alvo.click(); return alvo.innerText; }
    return null;
  })()
`;

// ─── KYC init script ──────────────────────────────────────────────────────────

const KYC_INIT_SCRIPT = `
  (function() {
    if (window.__kycInjected) return;
    window.__kycInjected = true;

    var PROVIDERS = {
      'Socure':  ['socure', 'devicer.io', 'sigma.socure', 'verify.socure'],
      'Veriff':  ['veriff', 'magic.veriff', 'api.veriff.me', 'cdn.veriff'],
      'Jumio':   ['jumio', 'lon.jumio', 'netverify'],
      'Onfido':  ['onfido', 'sdk.onfido'],
      'Persona': ['withpersona', 'persona.id'],
      'Stripe':  ['identity.stripe', 'stripe-js'],
      'Au10tix': ['au10tix'],
      'Mitek':   ['miteksystems', 'mitek'],
    };

    function analyze(url, source) {
      if (!url || typeof url !== 'string') return;
      var u = url.toLowerCase();
      for (var provider in PROVIDERS) {
        var patterns = PROVIDERS[provider];
        for (var i = 0; i < patterns.length; i++) {
          if (u.indexOf(patterns[i]) !== -1) {
            try { window.__kycSignal(provider, source, url, 5); } catch(e) {}
            window.dispatchEvent(new CustomEvent('__kyc_hit', { detail: { provider: provider, source: source, url: url } }));
            return;
          }
        }
      }
    }

    var _fetch = window.fetch;
    window.fetch = function() {
      try { analyze(arguments[0] && (arguments[0].url || arguments[0]), 'fetch'); } catch(e) {}
      return _fetch.apply(this, arguments);
    };

    var _open = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function(method, url) {
      try { analyze(url, 'xhr'); } catch(e) {}
      return _open.apply(this, arguments);
    };

    var _WS = window.WebSocket;
    if (_WS) {
      window.WebSocket = function(url, proto) {
        try { analyze(url, 'websocket'); } catch(e) {}
        return proto ? new _WS(url, proto) : new _WS(url);
      };
      window.WebSocket.prototype = _WS.prototype;
    }

    var _create = document.createElement.bind(document);
    document.createElement = function(tag) {
      var el = _create(tag);
      var t = tag.toLowerCase();
      if (t === 'script' || t === 'iframe') {
        var proto = t === 'script' ? HTMLScriptElement.prototype : HTMLIFrameElement.prototype;
        var d = Object.getOwnPropertyDescriptor(proto, 'src');
        if (d) {
          Object.defineProperty(el, 'src', {
            set: function(v) { analyze(v, t + '-tag'); return d.set.call(this, v); },
            get: function()  { return d.get.call(this); },
            configurable: true
          });
        }
      }
      return el;
    };

    new MutationObserver(function(ms) {
      ms.forEach(function(m) {
        m.addedNodes.forEach(function(n) {
          if (!n.tagName) return;
          var tag = n.tagName.toUpperCase();
          if (tag === 'SCRIPT' || tag === 'IFRAME') {
            var src = n.src || n.getAttribute('src') || '';
            analyze(src, tag.toLowerCase() + '-dom');
          }
          if (tag === 'LINK') {
            var href = n.href || n.getAttribute('href') || '';
            analyze(href, 'link-dom');
          }
        });
      });
    }).observe(document.documentElement, { childList: true, subtree: true });

    try {
      var po = new PerformanceObserver(function(list) {
        list.getEntries().forEach(function(entry) {
          analyze(entry.name, 'perf-observer');
        });
      });
      po.observe({ type: 'resource', buffered: true });
    } catch(e) {}

  })();
`;

// ─── Stealth script melhorado ─────────────────────────────────────────────────
// + AudioContext noise, Date.now jitter, chrome.runtime masking

const stealthScript = `
  (function() {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    Object.defineProperty(navigator, 'platform',          { get: () => 'iPhone' });
    Object.defineProperty(navigator, 'maxTouchPoints',    { get: () => 5 });
    Object.defineProperty(navigator, 'languages',         { get: () => ['pt-BR', 'pt', 'en-US', 'en'] });
    Object.defineProperty(navigator, 'hardwareConcurrency',{ get: () => 6 });
    Object.defineProperty(navigator, 'plugins', {
      get: () => {
        const arr = Object.create(PluginArray.prototype);
        Object.defineProperty(arr, 'length', { value: 0 });
        arr.item = () => null; arr.namedItem = () => null; arr.refresh = () => {};
        return arr;
      }
    });
    if (navigator.connection) {
      Object.defineProperty(navigator.connection, 'effectiveType', { get: () => '4g' });
      Object.defineProperty(navigator.connection, 'rtt',           { get: () => 80 });
      Object.defineProperty(navigator.connection, 'downlink',      { get: () => 8 });
      Object.defineProperty(navigator.connection, 'saveData',      { get: () => false });
    }
    Object.defineProperty(screen, 'colorDepth', { get: () => 24 });
    Object.defineProperty(screen, 'pixelDepth', { get: () => 24 });
    const _origQuery = window.navigator.permissions.query.bind(navigator.permissions);
    window.navigator.permissions.query = (p) =>
      p.name === 'notifications'
        ? Promise.resolve({ state: Notification.permission, onchange: null })
        : _origQuery(p);
    const origToDataURL = HTMLCanvasElement.prototype.toDataURL;
    HTMLCanvasElement.prototype.toDataURL = function(type) {
      const ctx = this.getContext('2d');
      if (ctx) {
        const noise = ctx.createImageData(1, 1);
        noise.data[0] = Math.floor(Math.random() * 3);
        ctx.putImageData(noise, Math.random() * this.width | 0, Math.random() * this.height | 0);
      }
      return origToDataURL.apply(this, arguments);
    };
    const getParameter = WebGLRenderingContext.prototype.getParameter;
    WebGLRenderingContext.prototype.getParameter = function(param) {
      if (param === 37445) return 'Apple Inc.';
      if (param === 37446) return 'Apple GPU';
      return getParameter.call(this, param);
    };
    // AudioContext fingerprint noise
    try {
      const _AC = window.AudioContext || window.webkitAudioContext;
      if (_AC) {
        const _createBuffer = _AC.prototype.createBuffer;
        _AC.prototype.createBuffer = function(channels, length, sampleRate) {
          const buf = _createBuffer.call(this, channels, length, sampleRate);
          const noise = 0.0001;
          for (let c = 0; c < buf.numberOfChannels; c++) {
            const data = buf.getChannelData(c);
            for (let i = 0; i < data.length; i++) {
              data[i] += (Math.random() * 2 - 1) * noise;
            }
          }
          return buf;
        };
      }
    } catch(e) {}
    // Date.now jitter — dificulta detecção de timing exato de automação
    const _dateNow = Date.now;
    Date.now = function() { return _dateNow() + Math.floor(Math.random() * 3); };
    // Mascara chrome.runtime (Arkose verifica presença)
    if (window.chrome) {
      try {
        Object.defineProperty(window.chrome, 'runtime', {
          get: () => ({ connect: () => {}, sendMessage: () => {}, id: undefined }),
          configurable: true,
        });
      } catch(e) {}
    }
  })();
`;

// ─── KYC patterns ─────────────────────────────────────────────────────────────

const KYC_PATTERNS: Array<{ pattern: RegExp; provider: string }> = [
  { pattern: /socure/i,              provider: 'Socure'  },
  { pattern: /devicer\.io/i,         provider: 'Socure'  },
  { pattern: /sigma\.socure/i,       provider: 'Socure'  },
  { pattern: /verify\.socure/i,      provider: 'Socure'  },
  { pattern: /veriff/i,              provider: 'Veriff'  },
  { pattern: /magic\.veriff/i,       provider: 'Veriff'  },
  { pattern: /api\.veriff\.me/i,     provider: 'Veriff'  },
  { pattern: /cdn\.veriff/i,         provider: 'Veriff'  },
  { pattern: /jumio/i,               provider: 'Jumio'   },
  { pattern: /lon\.jumio/i,          provider: 'Jumio'   },
  { pattern: /netverify/i,           provider: 'Jumio'   },
  { pattern: /onfido/i,              provider: 'Onfido'  },
  { pattern: /sdk\.onfido/i,         provider: 'Onfido'  },
  { pattern: /withpersona/i,         provider: 'Persona' },
  { pattern: /persona\.id/i,         provider: 'Persona' },
  { pattern: /identity\.stripe/i,    provider: 'Stripe'  },
  { pattern: /au10tix/i,             provider: 'Au10tix' },
  { pattern: /miteksystems/i,        provider: 'Mitek'   },
];

function detectKycProvider(url: string): string | null {
  for (const { pattern, provider } of KYC_PATTERNS) {
    if (pattern.test(url)) return provider;
  }
  return null;
}

// ─── Listeners ────────────────────────────────────────────────────────────────

function registrarListenersFrame(frame: Frame, cycle: number): void {
  try {
    const url = frame.url();
    const provider = detectKycProvider(url);
    if (provider) globalState.addKycSignal(provider, 'frame-url', 5, cycle, url);
  } catch { /* ignora */ }
}

function registrarListenersPage(page: Page, cycle: number): void {
  try {
    for (const frame of page.frames()) registrarListenersFrame(frame, cycle);
  } catch { /* ignora */ }

  page.on('frameattached',  (frame) => registrarListenersFrame(frame, cycle));
  page.on('framenavigated', (frame) => {
    const url = frame.url();
    const provider = detectKycProvider(url);
    if (provider) globalState.addKycSignal(provider, 'frame-navigated', 5, cycle, url);
  });
  page.on('websocket', (ws) => {
    const url = ws.url();
    const provider = detectKycProvider(url);
    if (provider) globalState.addKycSignal(provider, 'websocket-native', 5, cycle, url);
  });
  page.on('request', (req) => {
    const url = req.url();
    const provider = detectKycProvider(url);
    if (provider) globalState.addKycSignal(provider, 'page-request', 4, cycle, url);
  });
  page.exposeFunction('__kycSignal', (provider: string, source: string, url: string, weight: number) => {
    globalState.addKycSignal(provider, source, weight, cycle, url);
  }).catch(() => {});
}

function getFirstAvailableProxy(): { server: string; username?: string; password?: string } | null {
  const proxies = (globalState.getState().config as any).proxies as Array<{server:string;username?:string;password?:string}> | undefined;
  if (!proxies || proxies.length === 0) return null;
  return proxies[0] ?? null;
}

// ─── Cria contexto isolado ────────────────────────────────────────────────────

async function criarContextoIsolado(
  cycle: number
): Promise<{ context: BrowserContext; page: Page }> {
  const proxy = getFirstAvailableProxy();

  if (proxy) {
    try {
      const p = new URL(buildProxyServerArg(proxy.server));
      log('info', `🌐 [Proxy] Ciclo #${cycle} → ${p.host}` + (proxy.username ? ` | usuário: ${proxy.username}` : ''), cycle);
    } catch {
      log('info', `🌐 [Proxy] Ciclo #${cycle} → proxy ativo`, cycle);
    }
  } else {
    log('warn', `⚠️ [Proxy] Ciclo #${cycle} → SEM proxy configurado`, cycle);
  }

  const proxyConfig = proxy
    ? {
        server: buildProxyServerArg(proxy.server),
        ...(proxy.username ? { username: proxy.username } : {}),
        ...(proxy.password ? { password: proxy.password } : {}),
      }
    : undefined;

  const context = await browser!.newContext({
    ...MOBILE_DEVICE,
    locale: 'pt-BR',
    timezoneId: 'America/Sao_Paulo',
    geolocation: { latitude: -23.5505, longitude: -46.6333 },
    permissions: ['geolocation'],
    extraHTTPHeaders: { 'Accept-Language': 'pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7' },
    ...(proxyConfig ? { proxy: proxyConfig } : {}),
  });

  await context.addInitScript({ content: stealthScript });
  await context.addInitScript({ content: KYC_INIT_SCRIPT });

  await context.route('**/*', (route) => {
    const url = route.request().url();
    const provider = detectKycProvider(url);
    if (provider) globalState.addKycSignal(provider, 'network-route', 3, cycle, url);
    route.continue();
  });

  const page = await context.newPage();

  page.on('request', (req) => {
    if (req.method() === 'POST') {
      const url = req.url();
      const body = req.postData() ?? '';
      if (
        url.includes('auth') || url.includes('login') || url.includes('signup') ||
        url.includes('otp') || url.includes('email') || url.includes('uber') ||
        url.includes('identity') || url.includes('forward')
      ) {
        log('info', `📡 [NET] POST ${url.split('?')[0]} | body: ${body.slice(0, 300)}`, cycle);
      }
    }
  });

  context.on('page', async (novaPage) => {
    try {
      const temOpener = await novaPage.evaluate(() => window.opener !== null).catch(() => false);
      if (!temOpener) {
        log('info', `🪟 Nova aba sem opener — ignorando`, cycle);
        return;
      }
      const url = novaPage.url();
      log('info', `📌 Popup interceptado (${url || 'about:blank'}) — fechando`, cycle);
      registrarListenersPage(novaPage, cycle);
      await new Promise<void>((r) => setTimeout(r, 800));
      await novaPage.close().catch(() => {});
    } catch { /* não fecha se não conseguir verificar */ }
  });

  try {
    const cdp = await context.newCDPSession(page);
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      mobile: true,
      width: MOBILE_DEVICE.viewport?.width ?? 390,
      height: MOBILE_DEVICE.viewport?.height ?? 844,
      deviceScaleFactor: MOBILE_DEVICE.deviceScaleFactor ?? 3,
      screenOrientation: { angle: 0, type: 'portraitPrimary' },
    });
    await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
    await cdp.send('Emulation.setUserAgentOverride', {
      userAgent: MOBILE_DEVICE.userAgent ?? '',
      acceptLanguage: 'pt-BR,pt;q=0.9',
      platform: 'iPhone',
    });
    log('info', `📱 CDP mobile ativado`, cycle);
  } catch (e) {
    log('warn', `⚠️ CDP mobile falhou: ${e}`, cycle);
  }

  registrarListenersPage(page, cycle);
  contextosPorCiclo.set(cycle, context);
  return { context, page };
}

async function fecharContextoCiclo(cycle: number, motivo: string): Promise<void> {
  const ctx = contextosPorCiclo.get(cycle);
  if (ctx) {
    log('warn', `🧹 Fechando aba do ciclo #${cycle} — motivo: ${motivo}`, cycle);
    await ctx.close().catch(() => {});
    contextosPorCiclo.delete(cycle);
  }
  globalState.clearPayload(cycle);
}

// ─── WhatsApp ─────────────────────────────────────────────────────────────────

async function dispensarWhatsApp(p: Page, cycle: number): Promise<void> {
  try {
    await humanPause(randInt(sp(2000), sp(3500)));
    const SELETORES_WHATSAPP = [
      'button:has-text("ÃO ATIVAR")',
      'button:has-text("Nao ativar")',
      'button:has-text("Not now")',
      'button:has-text("Agora não")',
      '[data-testid*="whatsapp"]',
      'button[type="submit"]',
    ];
    const TIMEOUT_MS = 30_000;
    const POLL_MS = isSpeedMode() ? 1_000 : 3_000;
    const inicio = Date.now();
    let detectado = false;

    log('info', '🔍 Aguardando tela do WhatsApp (até 30s)...', cycle);
    while (Date.now() - inicio < TIMEOUT_MS) {
      for (const sel of SELETORES_WHATSAPP) {
        try {
          const visivel = await p.locator(sel).first().isVisible({ timeout: 1000 }).catch(() => false);
          if (visivel) { detectado = true; break; }
        } catch { /* ignora */ }
      }
      if (detectado) break;
      await humanPause(POLL_MS);
    }

    if (!detectado) {
      log('warn', '⚠️ Tela WhatsApp não detectada após 30s, pulando...', cycle);
      return;
    }

    log('info', '📲 Tela WhatsApp detectada, clicando em NÃO ATIVAR...', cycle);
    await humanPause(randInt(sp(400), sp(800)));

    for (const sel of ['button:has-text("NÃO ATIVAR")', 'button:has-text("Nao ativar")', 'button:has-text("Not now")', 'button:has-text("Agora não")']) {
      try {
        const el = p.locator(sel).first();
        const visivel = await el.isVisible({ timeout: 2000 }).catch(() => false);
        if (visivel) {
          const box = await el.boundingBox().catch(() => null);
          if (box) {
            await humanMouseMove(p, box.x + box.width / 2, box.y + box.height / 2);
            await humanPause(randInt(sp(150), sp(300)));
          }
          await el.click({ timeout: 5000 });
          log('info', `🔕 WhatsApp: NÃO ATIVAR clicado (${sel})`, cycle);
          await humanPause(randInt(sp(400), sp(800)));
          return;
        }
      } catch { /* tenta próxima */ }
    }

    try {
      const clicou = await p.evaluate(JS_NAO_ATIVAR) as boolean;
      if (clicou) { log('info', '🔕 WhatsApp: NÃO ATIVAR clicado (JS normalize)', cycle); return; }
    } catch { /* ignora */ }

    try {
      const clicou = await p.evaluate(JS_FALLBACK_SUBMIT) as string | null;
      if (clicou) { log('info', `🔕 WhatsApp: botão "${clicou}" clicado (fallback)`, cycle); return; }
    } catch { /* ignora */ }

    log('warn', '⚠️ Tela detectada mas não foi possível clicar em NÃO ATIVAR — continuando...', cycle);
  } catch (err) {
    log('warn', `⚠️ dispensarWhatsApp erro inesperado (ignorado): ${err}`, cycle);
  }
}

// ─── KYC: resolve provider dominante ─────────────────────────────────────────

function resolverProviderDominante(
  cycle: number,
  scoreMinimo = 4
): { provider: string; score: number; url: string } | null {
  const { byCycle } = globalState.getKycState();
  const cicloMap = byCycle[cycle];
  if (!cicloMap) return null;
  let melhor: { provider: string; score: number; url: string } | null = null;
  for (const [provider, state] of Object.entries(cicloMap)) {
    if (state.score >= scoreMinimo) {
      if (!melhor || state.score > melhor.score) {
        melhor = { provider, score: state.score, url: state.signals[0]?.url ?? '' };
      }
    }
  }
  return melhor;
}

// ─── Polling do botão "Tirar foto" ────────────────────────────────────────────

async function pollingBotaoTirarFoto(
  p: Page,
  seletoresItem: string[],
  seletoresBotao: string[],
  cycle: number,
  timeoutMs = 60_000
): Promise<boolean> {
  const POLL_INTERVAL_MS = isSpeedMode() ? 1_500 : 3_000;
  const inicio = Date.now();
  let tentativa = 0;

  log('info', `📸 [TirarFoto] Iniciando polling (timeout: ${timeoutMs / 1000}s, intervalo: ${POLL_INTERVAL_MS / 1000}s)`, cycle);

  while (Date.now() - inicio < timeoutMs) {
    tentativa++;
    log('info', `🔄 [TirarFoto] Poll #${tentativa} — buscando botão...`, cycle);

    for (const sel of seletoresBotao) {
      try {
        const el = p.locator(sel).first();
        const visivel = await el.isVisible({ timeout: 1200 }).catch(() => false);
        if (visivel) {
          const box = await el.boundingBox().catch(() => null);
          if (box) {
            await humanMouseMove(p, box.x + box.width / 2, box.y + box.height / 2);
            await humanPause(randInt(sp(200), sp(400)));
          }
          await el.click({ force: true, timeout: 5000 });
          log('info', `✅ [TirarFoto] Poll #${tentativa} — botão clicado! (${sel})`, cycle);
          return true;
        }
      } catch { /* tenta próximo seletor */ }
    }

    log('info', `📌 [TirarFoto] Poll #${tentativa} — botão não encontrado ainda`, cycle);

    if (tentativa % 2 === 0) {
      try {
        const scrollY = tentativa % 4 === 0 ? 0 : 300;
        await p.evaluate(`window.scrollBy(0, ${scrollY})`);
        await humanPause(randInt(sp(300), sp(600)));
        for (const sel of seletoresBotao) {
          try {
            const el = p.locator(sel).first();
            const visivel = await el.isVisible({ timeout: 1200 }).catch(() => false);
            if (visivel) {
              const box = await el.boundingBox().catch(() => null);
              if (box) {
                await humanMouseMove(p, box.x + box.width / 2, box.y + box.height / 2);
                await humanPause(randInt(sp(200), sp(400)));
              }
              await el.click({ force: true, timeout: 5000 });
              log('info', `✅ [TirarFoto] Poll #${tentativa} (pós-scroll) — botão clicado! (${sel})`, cycle);
              return true;
            }
          } catch { /* ignora */ }
        }
      } catch (e) {
        log('warn', `⚠️ [TirarFoto] Poll #${tentativa} — erro no scroll: ${e}`, cycle);
      }
    }

    if (tentativa % 3 === 0) {
      log('info', `🔁 [TirarFoto] Poll #${tentativa} — re-clicando em "Foto do perfil"...`, cycle);
      try {
        await p.evaluate('window.scrollTo(0, 0)');
        await humanPause(randInt(sp(400), sp(700)));
        for (const sel of seletoresItem) {
          try {
            const el = p.locator(sel).first();
            const visivel = await el.isVisible({ timeout: 1500 }).catch(() => false);
            if (visivel) {
              const box = await el.boundingBox().catch(() => null);
              if (box) {
                await humanMouseMove(p, box.x + box.width / 2, box.y + box.height / 2);
                await humanPause(randInt(sp(200), sp(400)));
              }
              await el.click({ force: true, timeout: 5000 });
              log('info', `📸 [TirarFoto] Poll #${tentativa} — "Foto do perfil" re-clicado (${sel})`, cycle);
              await humanPause(randInt(sp(1000), sp(2000)));
              break;
            }
          } catch { /* ignora */ }
        }
      } catch (e) {
        log('warn', `⚠️ [TirarFoto] Poll #${tentativa} — erro no re-clique: ${e}`, cycle);
      }
    }

    const restante = timeoutMs - (Date.now() - inicio);
    if (restante > 0) {
      log('info', `⏳ [TirarFoto] Poll #${tentativa} — aguardando ${POLL_INTERVAL_MS / 1000}s (restam ${Math.round(restante / 1000)}s)...`, cycle);
      await humanPause(POLL_INTERVAL_MS);
    }
  }

  log('warn', `❌ [TirarFoto] Timeout após ${tentativa} polls (${timeoutMs / 1000}s) — botão não encontrado`, cycle);
  return false;
}

// ─── Foto do perfil + KYC ─────────────────────────────────────────────────────

async function clicarFotoPerfil(p: Page, cycle: number, context: BrowserContext): Promise<void> {
  log('info', '📸 Aguardando tela de lista de requisitos (Foto do perfil)...', cycle);

  const SELETORES_ITEM = [
    '[data-testid="stepItem profilePhoto"]',
    '[data-dgui="requirement-list-item"]:has-text("Foto do perfil")',
    '[data-dgui="requirement-list-item"]:has-text("Foto")',
    'a:has-text("Foto do perfil")',
    'a:has-text("Foto")',
    '[data-tracking-name="requirement-list-item"]:has-text("Foto")',
    '[role="listitem"]:has-text("Foto do perfil")',
    '[role="listitem"]:has-text("Foto")',
    'li:has-text("Foto do perfil")',
    'li:has-text("Foto")',
  ];

  const SELETORES_BOTAO_FOTO = [
    '[data-dgui="button"]:has-text("Tirar foto")',
    'button:has-text("Tirar foto")',
    'button:has-text("Usar meu telefone")',
    'button:has-text("Enviar foto")',
    'button:has-text("Escolher foto")',
    'button:has-text("Take photo")',
    'button:has-text("Upload photo")',
    '[data-testid="step-bottom-navigation"] button',
    '[data-testid="step-bottom-navigation"] [data-dgui="button"]',
    '[data-dgui="button"]',
  ];

  const TIMEOUT_ITEM = 20_000;
  const inicioItem = Date.now();
  let clicouItem = false;

  while (Date.now() - inicioItem < TIMEOUT_ITEM) {
    for (const sel of SELETORES_ITEM) {
      try {
        const el = p.locator(sel).first();
        const visivel = await el.isVisible({ timeout: 1500 }).catch(() => false);
        if (visivel) {
          const box = await el.boundingBox().catch(() => null);
          if (box) {
            await humanMouseMove(p, box.x + box.width / 2, box.y + box.height / 2);
            await humanPause(randInt(sp(200), sp(400)));
          }
          await el.click({ force: true, timeout: 5000 });
          log('info', `📸 "Foto do perfil" clicado (${sel})`, cycle);
          clicouItem = true;
          break;
        }
      } catch { /* tenta próximo seletor */ }
    }
    if (clicouItem) break;
    await humanPause(isSpeedMode() ? 600 : 1500);
  }

  if (!clicouItem) {
    log('warn', '⚠️ "Foto do perfil" não encontrado após 20s, pulando...', cycle);
    return;
  }

  await humanPause(randInt(sp(1200), sp(2000)));

  const botaoClicado = await pollingBotaoTirarFoto(p, SELETORES_ITEM, SELETORES_BOTAO_FOTO, cycle, 60_000);

  if (!botaoClicado) {
    log('warn', '⚠️ Botão de foto não encontrado após polling completo', cycle);
  }

  const salvarContaSocure = async (): Promise<void> => {
    const payload = globalState.getPayload(cycle);
    if (!payload) { log('warn', '⚠️ Payload não encontrado — conta não salva', cycle); return; }
    try {
      const cookies = await context.cookies();
      const saved = accountStore.save({
        cycle,
        provider: 'Socure',
        nome: payload.nome,
        sobrenome: payload.sobrenome,
        email: payload.email,
        telefone: payload.telefone,
        senha: payload.senha,
        localizacao: payload.localizacao,
        codigoIndicacao: payload.codigoIndicacao,
        cookies,
      });
      log('success', `💾 Conta salva! id=${saved.id} | ${payload.email}`, cycle);
    } catch (e) {
      log('warn', `⚠️ Erro ao salvar conta: ${e}`, cycle);
    } finally {
      globalState.clearPayload(cycle);
    }
  };

  const detectarEFechar = async (provider: string, score: number, url: string): Promise<void> => {
    if (provider === 'Veriff') {
      log('info', `🗑️ Veriff detectado (score=${score}) → fechando aba para liberar RAM`, cycle);
      await humanPause(randInt(sp(500), sp(1000)));
      await context.close().catch(() => {});
      contextosPorCiclo.delete(cycle);
      globalState.clearPayload(cycle);
    } else {
      log('success', `🟢 ${provider} detectado (score=${score}, url=${url}) → aba mantida aberta`, cycle);
      if (provider === 'Socure') await salvarContaSocure();
    }
  };

  log('info', '⏳ Aguardando KYC inicializar (até 30s)...', cycle);
  const fimKyc1 = Date.now() + 30_000;
  while (Date.now() < fimKyc1) {
    const dominante = resolverProviderDominante(cycle, 4);
    if (dominante) {
      log('info', `✅ KYC detectado: ${dominante.provider} (score=${dominante.score})`, cycle);
      await detectarEFechar(dominante.provider, dominante.score, dominante.url);
      return;
    }
    await humanPause(isSpeedMode() ? 500 : 1000);
  }

  log('warn', '⚠️ KYC não detectado após 30s — aguardando mais 20s (re-poll)...', cycle);
  const fimKyc2 = Date.now() + 20_000;
  while (Date.now() < fimKyc2) {
    const dominante = resolverProviderDominante(cycle, 4);
    if (dominante) {
      log('info', `✅ KYC detectado (re-poll): ${dominante.provider} (score=${dominante.score})`, cycle);
      await detectarEFechar(dominante.provider, dominante.score, dominante.url);
      return;
    }
    await humanPause(isSpeedMode() ? 500 : 1000);
  }

  log('warn', '⚠️ KYC não detectado após 50s total. Aba mantida aberta para inspeção.', cycle);
}

// ─── Flow principal ───────────────────────────────────────────────────────────

export class MockPlaywrightFlow {
  static async init(headless = true): Promise<void> {
    const firstProxy = getFirstAvailableProxy();
    const proxyServerArg = firstProxy ? buildProxyServerArg(firstProxy.server) : '__system__';

    if (browser && currentLaunchProxy === proxyServerArg) {
      log('info', '🌐 Browser já está rodando — reutilizando');
      return;
    }

    if (browser && currentLaunchProxy !== proxyServerArg) {
      log('warn', '🔄 Proxy mudou — reiniciando browser...');
      await browser.close().catch(() => {});
      browser = null;
      currentLaunchProxy = null;
      contextosPorCiclo.clear();
    }

    if (browserLaunching) {
      log('info', '⏳ Aguardando browser iniciar...');
      const deadline = Date.now() + 30_000;
      while (!browser && Date.now() < deadline) await new Promise<void>((r) => setTimeout(r, 200));
      if (!browser) throw new Error('Timeout aguardando browser iniciar');
      return;
    }

    browserLaunching = true;
    try {
      if (firstProxy) {
        try {
          const p = new URL(proxyServerArg);
          log('info', `🐧 Iniciando Chromium headless (Railway) | proxy: ${p.host}`);
        } catch {
          log('info', '🐧 Iniciando Chromium headless (Railway) | proxy: ativo');
        }
      } else {
        log('info', '🐧 Iniciando Chromium headless (Railway) | sem proxy');
      }

      browser = await chromiumExtra.launch({
        headless: true,
        slowMo: 0,
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-blink-features=AutomationControlled',
          '--disable-infobars',
          '--disable-dev-shm-usage',
          '--disable-gpu',
          '--no-first-run',
          '--no-default-browser-check',
          '--disable-features=IsolateOrigins,site-per-process',
          '--disable-site-isolation-trials',
          '--disable-extensions',
          ...(firstProxy ? [`--proxy-server=${proxyServerArg}`, '--proxy-bypass-list=<-loopback>'] : []),
        ],
      }) as unknown as Browser;

      currentLaunchProxy = proxyServerArg;
      log('info', firstProxy ? '✅ Browser pronto! (proxy ativo)' : '✅ Browser pronto! (sem proxy)');
    } finally {
      browserLaunching = false;
    }
  }

  static async execute(
    cadastroUrl: string,
    config: {
      emailProvider: EmailProvider;
      tempMailApiKey: string;
      otpTimeout: number;
      extraDelay: number;
      inviteCode: string;
    },
    cycle: number
  ): Promise<void> {
    if (!browser) throw new Error('Browser não inicializado — chame init() primeiro');

    const timeoutPromise = new Promise<never>((_, reject) =>
      setTimeout(
        () => reject(new Error(`⏱️ Ciclo #${cycle} excedeu o timeout de ${CYCLE_TIMEOUT_MS / 60_000} min`)),
        CYCLE_TIMEOUT_MS
      )
    );

    try {
      await Promise.race([timeoutPromise, MockPlaywrightFlow._executarCiclo(cadastroUrl, config, cycle)]);
    } catch (error) {
      await fecharContextoCiclo(cycle, String(error));
      throw error;
    }
  }

  private static async _executarCiclo(
    cadastroUrl: string,
    config: {
      emailProvider: EmailProvider;
      tempMailApiKey: string;
      otpTimeout: number;
      extraDelay: number;
      inviteCode: string;
    },
    cycle: number
  ): Promise<void> {
    log('info', `🆕 Ciclo #${cycle}: abrindo nova aba`, cycle);
    const { context, page: p } = await criarContextoIsolado(cycle);
    const client = createEmailClient(config.emailProvider, config.tempMailApiKey);

    try {
      await p.goto(cadastroUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
      // networkidle dá tempo ao Arkose de carregar e registrar os primeiros eventos
      await p.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
      log('info', '🌐 Página de cadastro aberta', cycle);

      // Aquecimento — constrói histórico de interação ANTES de tocar no formulário
      await pageWarmup(p, cycle);

      const emailAccount = await client.createRandomEmail();
      const payload = gerarPayloadCompleto(emailAccount, config.inviteCode);
      log('info', `👤 ${payload.nome} ${payload.sobrenome} | ${payload.email}`, cycle);

      globalState.setPayload(cycle, {
        nome: payload.nome,
        sobrenome: payload.sobrenome,
        email: payload.email,
        telefone: payload.telefone,
        senha: payload.senha,
        localizacao: payload.localizacao,
        codigoIndicacao: payload.codigoIndicacao,
      });

      log('info', '📧 Preenchendo email...', cycle);
      await humanTypeForce(p, '#PHONE_NUMBER_or_EMAIL_ADDRESS', payload.email);

      // Pausa pós-digitação — usuário confere o email antes de continuar
      await cogPause(config.extraDelay, config.extraDelay + 600);

      const emailNocampo = await p.locator('#PHONE_NUMBER_or_EMAIL_ADDRESS').inputValue().catch(() => '??');
      log('info', `🔍 [DEBUG] Email no campo antes do clique: "${emailNocampo}"`, cycle);

      await clickForwardButton(p, cycle);

      // Aguarda a tela de OTP aparecer — não dispara waitForOTP antes da navegação
      log('info', '⏳ Aguardando tela de OTP (#EMAIL_OTP_CODE-0)...', cycle);
      await p.waitForSelector('#EMAIL_OTP_CODE-0', { state: 'visible', timeout: 40000 });
      log('info', `🔑 Tela de OTP detectada! Aguardando código (timeout: ${config.otpTimeout / 1000}s)...`, cycle);

      const otp = await client.waitForOTP(payload.email, config.otpTimeout, cycle);
      log('info', `🔑 OTP recebido: ${otp}`, cycle);

      await humanPause(randInt(sp(800), sp(1400)));
      const digits = otp.replace(/\D/g, '').split('');
      for (let i = 0; i < digits.length; i++) {
        await humanType(p, `#EMAIL_OTP_CODE-${i}`, digits[i]!);
        await humanPause(randInt(sp(60), sp(140)));
      }
      await cogPause(config.extraDelay, config.extraDelay + 400);
      await clickForwardButton(p, cycle);

      await humanPause(randInt(sp(400), sp(900)));
      await humanType(p, '#PHONE_NUMBER', payload.telefone);
      await cogPause(config.extraDelay, config.extraDelay + 400);
      await clickForwardButton(p, cycle);

      await humanPause(randInt(sp(400), sp(900)));
      await humanType(p, '#PASSWORD', payload.senha);
      await cogPause(config.extraDelay, config.extraDelay + 400);
      await clickForwardButton(p, cycle);

      await humanPause(randInt(sp(400), sp(900)));
      await humanType(p, '#FIRST_NAME', payload.nome);
      await humanPause(randInt(sp(250), sp(500)));
      await humanType(p, '#LAST_NAME', payload.sobrenome);
      await cogPause(config.extraDelay, config.extraDelay + 400);
      await clickForwardButton(p, cycle);

      await aceitarTermos(p);
      await cogPause(config.extraDelay, config.extraDelay + 500);
      await clickForwardButton(p, cycle);

      await p.waitForURL('**/bonjour.uber.com/**', { timeout: 40000 });
      await humanPause(randInt(sp(700), sp(1400)));

      await dispensarCookies(p);
      await selecionarCidade(p, payload.localizacao, cycle);
      await dispensarCookies(p);

      await humanTypeForce(p, '[data-testid="signup-step::invite-code-input"]', payload.codigoIndicacao);
      await cogPause(config.extraDelay, config.extraDelay + 500);
      await dispensarCookies(p);
      await humanClick(p, '[data-testid="submit-button"]');

      await dispensarWhatsApp(p, cycle);
      await clicarFotoPerfil(p, cycle, context);

      const aindaAberta = contextosPorCiclo.has(cycle);
      log(
        aindaAberta ? 'success' : 'info',
        `${aindaAberta ? '🎉' : '✅'} Ciclo #${cycle} concluído!`,
        cycle
      );
    } catch (error) {
      globalState.clearPayload(cycle);
      await ArtifactsManager.saveErrorArtifacts(p, cycle);
      throw error;
    }
  }

  static async cleanup(): Promise<void> {
    for (const [cycle, ctx] of contextosPorCiclo.entries()) {
      await ctx.close().catch(() => {});
      log('info', `🗑️ Aba do ciclo #${cycle} fechada`);
    }
    contextosPorCiclo.clear();
    await browser?.close().catch(() => {});
    browser = null;
    currentLaunchProxy = null;
    log('info', '🧹 Browser fechado');
  }
}
