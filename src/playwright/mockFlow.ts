import { chromium as chromiumExtra } from 'playwright-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import { Browser, Page, BrowserContext, Frame, devices } from 'playwright';
import { globalState } from '../state/globalState';
import { createEmailClient } from '../tempMail/client';
import { IEmailClient } from '../types/tempMail';
import { EmailProvider } from '../types';
import { gerarPayloadCompleto } from '../utils/dataGenerators';
import { ArtifactsManager } from '../utils/artifacts';

chromiumExtra.use(StealthPlugin());

let browser: Browser | null = null;
let browserLaunching = false;
const contextosPorCiclo = new Map<number, BrowserContext>();

const BRAVE_PATH = 'C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe';

const MOBILE_DEVICE = devices['iPhone 14'];

const MOBILE_WIDTH  = MOBILE_DEVICE.viewport?.width  ?? 390;
const MOBILE_HEIGHT = MOBILE_DEVICE.viewport?.height ?? 844;
const MOBILE_DPR    = MOBILE_DEVICE.deviceScaleFactor ?? 3;
const MOBILE_UA     = MOBILE_DEVICE.userAgent ?? '';

// ─── Helpers humanos ──────────────────────────────────────────────────────────

function randInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

async function humanPause(baseMs: number): Promise<void> {
  const jitter = randInt(-Math.floor(baseMs * 0.15), Math.floor(baseMs * 0.2));
  await new Promise<void>((r) => setTimeout(r, Math.max(80, baseMs + jitter)));
}

async function humanMouseMove(p: Page, x: number, y: number): Promise<void> {
  const steps = randInt(5, 10);
  const startX = randInt(50, 300);
  const startY = randInt(100, 400);
  const cpX = startX + (x - startX) * 0.4 + randInt(-20, 20);
  const cpY = startY + (y - startY) * 0.4 + randInt(-15, 15);
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const bx = Math.round((1 - t) * (1 - t) * startX + 2 * (1 - t) * t * cpX + t * t * x);
    const by = Math.round((1 - t) * (1 - t) * startY + 2 * (1 - t) * t * cpY + t * t * y);
    await p.mouse.move(bx, by);
    await humanPause(randInt(5, 12));
  }
}

/**
 * Espera até que não haja nenhum elemento cobrindo o seletor alvo.
 * Usa string literal no p.evaluate para evitar que o TypeScript do Node
 * tente checar referências a `document` / `Node` (TS2584).
 */
async function waitForElementInteractable(p: Page, selector: string, timeoutMs = 15000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const box = await p.locator(selector).boundingBox();
      if (!box) { await humanPause(300); continue; }
      const cx = box.x + box.width / 2;
      const cy = box.y + box.height / 2;

      // String literal → TypeScript não faz type-check do conteúdo (roda só no browser)
      const isTarget = await p.evaluate(
        `(function(){ \
          var top = document.elementFromPoint(${cx}, ${cy}); \
          var target = document.querySelector(${JSON.stringify(selector)}); \
          if (!target || !top) return false; \
          return target === top || target.contains(top); \
        })()`
      ) as boolean;

      if (isTarget) return;
    } catch { /* ignora e repete */ }
    await humanPause(400);
  }
  // Timeout expirou — tenta mesmo assim (pior caso: force click)
}

async function humanType(p: Page, selector: string, value: string): Promise<void> {
  await p.waitForSelector(selector, { state: 'visible', timeout: 15000 });
  await waitForElementInteractable(p, selector, 12000);
  const box = await p.locator(selector).boundingBox();
  if (box) {
    const tx = Math.round(box.x + box.width * (0.3 + Math.random() * 0.4));
    const ty = Math.round(box.y + box.height * (0.3 + Math.random() * 0.4));
    await humanMouseMove(p, tx, ty);
    await humanPause(randInt(50, 100));
  }
  // Tenta clique normal; cai em force se falhar
  try {
    await p.click(selector, { timeout: 8000 });
  } catch {
    await p.click(selector, { force: true, timeout: 5000 });
  }
  await p.fill(selector, '');
  await humanPause(randInt(60, 150));
  for (let i = 0; i < value.length; i++) {
    const ch = value[i]!;
    if (Math.random() < 0.03 && /[a-zA-Z]/.test(ch)) {
      const typo = String.fromCharCode(ch.charCodeAt(0) + (Math.random() > 0.5 ? 1 : -1));
      await p.keyboard.type(typo, { delay: randInt(40, 80) });
      await humanPause(randInt(50, 120));
      await p.keyboard.press('Backspace');
      await humanPause(randInt(40, 90));
    }
    await p.keyboard.type(ch, { delay: randInt(35, 90) });
    if (ch === ' ' || ch === '@' || ch === '.') {
      await humanPause(randInt(80, 200));
    } else if (Math.random() < 0.05) {
      await humanPause(randInt(100, 300));
    }
  }
}

async function humanTypeForce(p: Page, selector: string, value: string): Promise<void> {
  await p.waitForSelector(selector, { state: 'visible', timeout: 15000 });
  const box = await p.locator(selector).boundingBox();
  if (box) {
    const tx = Math.round(box.x + box.width * (0.3 + Math.random() * 0.4));
    const ty = Math.round(box.y + box.height * (0.3 + Math.random() * 0.4));
    await humanMouseMove(p, tx, ty);
    await humanPause(randInt(50, 100));
  }
  await p.click(selector, { force: true });
  await p.fill(selector, '');
  await humanPause(randInt(60, 150));
  for (let i = 0; i < value.length; i++) {
    const ch = value[i]!;
    if (Math.random() < 0.03 && /[a-zA-Z]/.test(ch)) {
      const typo = String.fromCharCode(ch.charCodeAt(0) + (Math.random() > 0.5 ? 1 : -1));
      await p.keyboard.type(typo, { delay: randInt(40, 80) });
      await humanPause(randInt(50, 120));
      await p.keyboard.press('Backspace');
      await humanPause(randInt(40, 90));
    }
    await p.keyboard.type(ch, { delay: randInt(35, 90) });
    if (ch === ' ' || ch === '@' || ch === '.') {
      await humanPause(randInt(80, 200));
    } else if (Math.random() < 0.05) {
      await humanPause(randInt(100, 300));
    }
  }
}

async function humanClick(p: Page, selector: string): Promise<void> {
  await p.waitForSelector(selector, { state: 'visible', timeout: 15000 });
  await waitForElementInteractable(p, selector, 8000);
  const box = await p.locator(selector).boundingBox();
  if (box) {
    const tx = Math.round(box.x + box.width * (0.25 + Math.random() * 0.5));
    const ty = Math.round(box.y + box.height * (0.25 + Math.random() * 0.5));
    await humanMouseMove(p, tx, ty);
    await humanPause(randInt(40, 100));
    try {
      await p.mouse.click(tx, ty);
    } catch {
      await p.click(selector, { force: true });
    }
  } else {
    await p.click(selector, { force: true });
  }
}

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
          await humanPause(randInt(100, 200));
        }
        await el.click({ timeout: 3000 });
        globalState.addLog('info', `🍪 Banner de cookies dispensado (${seletor})`);
        await humanPause(randInt(300, 600));
        return;
      }
    } catch { /* ignora */ }
  }
}

async function aceitarTermos(p: Page): Promise<void> {
  await humanPause(randInt(500, 900));
  const candidatos = [
    async () => {
      const el = p.locator('input[type="checkbox"]').first();
      await el.waitFor({ state: 'attached', timeout: 8000 });
      const box = await el.boundingBox().catch(() => null);
      if (box) {
        await humanMouseMove(p, box.x + box.width / 2, box.y + box.height / 2);
        await humanPause(randInt(80, 160));
      }
      await el.check({ force: true, timeout: 5000 });
    },
    async () => {
      const el = p.locator('label:has-text("Concordo"), [class*="label"]:has-text("Concordo")').first();
      await el.waitFor({ state: 'attached', timeout: 5000 });
      const box = await el.boundingBox().catch(() => null);
      if (box) await humanMouseMove(p, box.x + box.width / 2, box.y + box.height / 2);
      await humanPause(randInt(60, 140));
      await el.click({ force: true, timeout: 5000 });
    },
    async () => {
      const el = p.locator('[role="checkbox"]').first();
      await el.waitFor({ state: 'attached', timeout: 5000 });
      const box = await el.boundingBox().catch(() => null);
      if (box) await humanMouseMove(p, box.x + box.width / 2, box.y + box.height / 2);
      await humanPause(randInt(60, 140));
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

  globalState.addLog('info', `📍 Digitando cidade: "${nomeBusca}"`, cycle);
  await p.waitForSelector(INPUT_SEL, { state: 'visible', timeout: 15000 });
  const box = await p.locator(INPUT_SEL).boundingBox().catch(() => null);
  if (box) {
    await humanMouseMove(p, box.x + box.width / 2, box.y + box.height / 2);
    await humanPause(randInt(80, 160));
  }
  await p.click(INPUT_SEL);
  await p.fill(INPUT_SEL, '');
  await humanPause(randInt(100, 200));
  for (const ch of nomeBusca) {
    await p.keyboard.type(ch, { delay: randInt(50, 110) });
    if (Math.random() < 0.08) await humanPause(randInt(80, 200));
  }

  globalState.addLog('info', '⏳ Aguardando dropdown de cidade...', cycle);
  let itemSel: string | null = null;
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
    await humanPause(500);
  }

  if (!itemSel) {
    globalState.addLog('warn', '⚠️ Dropdown não detectado, tentando ArrowDown+Enter', cycle);
    await humanPause(randInt(300, 600));
    await p.keyboard.press('ArrowDown');
    await humanPause(randInt(150, 300));
    await p.keyboard.press('Enter');
    return;
  }

  await humanPause(randInt(300, 600));
  const opcoes = p.locator(itemSel);
  const total = await opcoes.count();
  globalState.addLog('info', `📍 Dropdown aberto com ${total} opções`, cycle);

  let clicou = false;
  for (let i = 0; i < total; i++) {
    try {
      const opcao = opcoes.nth(i);
      const texto = await opcao.innerText().catch(() => '');
      if (norm(texto).includes(nomeBuscaNorm)) {
        const opcaoBox = await opcao.boundingBox().catch(() => null);
        if (opcaoBox) {
          await humanMouseMove(p, opcaoBox.x + opcaoBox.width / 2, opcaoBox.y + opcaoBox.height / 2);
          await humanPause(randInt(150, 300));
        }
        await opcao.click({ timeout: 5000 });
        globalState.addLog('info', `✅ Cidade selecionada: "${texto.trim()}"`, cycle);
        clicou = true;
        break;
      }
    } catch { /* tenta próxima */ }
  }

  if (!clicou) {
    globalState.addLog('warn', `⚠️ Nenhuma opção com "${nomeBusca}", clicando na primeira`, cycle);
    try {
      const primeiraBox = await opcoes.first().boundingBox().catch(() => null);
      if (primeiraBox) {
        await humanMouseMove(p, primeiraBox.x + primeiraBox.width / 2, primeiraBox.y + primeiraBox.height / 2);
        await humanPause(randInt(150, 300));
      }
      await opcoes.first().click({ timeout: 5000 });
    } catch {
      await p.keyboard.press('ArrowDown');
      await humanPause(randInt(150, 300));
      await p.keyboard.press('Enter');
    }
  }
  await humanPause(randInt(400, 700));
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

// ─── WhatsApp ─────────────────────────────────────────────────────────────────

async function dispensarWhatsApp(p: Page, cycle: number): Promise<void> {
  try {
    await humanPause(randInt(2000, 3500));
    const SELETORES_WHATSAPP = [
      'button:has-text("ÃO ATIVAR")',
      'button:has-text("Nao ativar")',
      'button:has-text("Not now")',
      'button:has-text("Agora não")',
      '[data-testid*="whatsapp"]',
      'button[type="submit"]',
    ];
    const TIMEOUT_MS = 30_000;
    const POLL_MS = 3_000;
    const inicio = Date.now();
    let detectado = false;

    globalState.addLog('info', '🔍 Aguardando tela do WhatsApp (até 30s)...', cycle);
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
      globalState.addLog('warn', '⚠️ Tela WhatsApp não detectada após 30s, pulando...', cycle);
      return;
    }

    globalState.addLog('info', '📲 Tela WhatsApp detectada, clicando em NÃO ATIVAR...', cycle);
    await humanPause(randInt(400, 800));

    const candidatosCss = [
      'button:has-text("NÃO ATIVAR")',
      'button:has-text("Nao ativar")',
      'button:has-text("Not now")',
      'button:has-text("Agora não")',
    ];
    for (const sel of candidatosCss) {
      try {
        const el = p.locator(sel).first();
        const visivel = await el.isVisible({ timeout: 2000 }).catch(() => false);
        if (visivel) {
          const box = await el.boundingBox().catch(() => null);
          if (box) {
            await humanMouseMove(p, box.x + box.width / 2, box.y + box.height / 2);
            await humanPause(randInt(150, 300));
          }
          await el.click({ timeout: 5000 });
          globalState.addLog('info', `🔕 WhatsApp: NÃO ATIVAR clicado (CSS: ${sel})`, cycle);
          await humanPause(randInt(400, 800));
          return;
        }
      } catch { /* tenta próxima */ }
    }

    try {
      const clicou = await p.evaluate(JS_NAO_ATIVAR) as boolean;
      if (clicou) {
        globalState.addLog('info', '🔕 WhatsApp: NÃO ATIVAR clicado (JS normalize)', cycle);
        await humanPause(randInt(400, 800));
        return;
      }
    } catch { /* ignora */ }

    try {
      const clicou = await p.evaluate(JS_FALLBACK_SUBMIT) as string | null;
      if (clicou) {
        globalState.addLog('info', `🔕 WhatsApp: botão "${clicou}" clicado (fallback submit)`, cycle);
        await humanPause(randInt(400, 800));
        return;
      }
    } catch { /* ignora */ }

    globalState.addLog('warn', '⚠️ Tela detectada mas não foi possível clicar em NÃO ATIVAR — continuando...', cycle);
  } catch (err) {
    globalState.addLog('warn', `⚠️ dispensarWhatsApp erro inesperado (ignorado): ${err}`, cycle);
  }
}

// ─── KYC: resolve provider dominante por score ────────────────────────────────

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
        const urlSinal = state.signals[0]?.url ?? '';
        melhor = { provider, score: state.score, url: urlSinal };
      }
    }
  }
  return melhor;
}

// ─── OTP: polling com retentativas e re-envio ─────────────────────────────────

async function aguardarOTPComRetry(
  p: Page,
  client: IEmailClient,
  email: string,
  otpTimeout: number,
  cycle: number
): Promise<string> {
  const MAX_TENTATIVAS = 3;
  const POLL_INTERVAL  = 5_000;
  const JANELA_MS = Math.max(20_000, Math.floor(otpTimeout / MAX_TENTATIVAS));

  const SELETORES_REENVIO = [
    'button:has-text("Reenviar")',
    'button:has-text("Resend")',
    'button:has-text("Reenviar código")',
    'a:has-text("Reenviar")',
    'a:has-text("Resend")',
    '[data-testid*="resend"]',
    'span:has-text("Reenviar")',
  ];

  for (let tentativa = 1; tentativa <= MAX_TENTATIVAS; tentativa++) {
    globalState.addLog(
      'info',
      `🔑 OTP tentativa ${tentativa}/${MAX_TENTATIVAS} — aguardando até ${JANELA_MS / 1000}s...`,
      cycle
    );

    const fimJanela = Date.now() + JANELA_MS;
    while (Date.now() < fimJanela) {
      try {
        const otp = await client.waitForOTP(email, POLL_INTERVAL);
        if (otp) {
          globalState.addLog('info', `🔑 OTP recebido na tentativa ${tentativa}: ${otp}`, cycle);
          return otp;
        }
      } catch { /* continua polling */ }
      if (Date.now() >= fimJanela) break;
      await humanPause(POLL_INTERVAL);
    }

    if (tentativa < MAX_TENTATIVAS) {
      globalState.addLog('warn', `⚠️ OTP não chegou em ${JANELA_MS / 1000}s — tentando reenviar...`, cycle);
      let reenvioClicado = false;
      for (const sel of SELETORES_REENVIO) {
        try {
          const el = p.locator(sel).first();
          const visivel = await el.isVisible({ timeout: 2000 }).catch(() => false);
          if (visivel) {
            const box = await el.boundingBox().catch(() => null);
            if (box) {
              await humanMouseMove(p, box.x + box.width / 2, box.y + box.height / 2);
              await humanPause(randInt(200, 400));
            }
            await el.click({ timeout: 5000 });
            globalState.addLog('info', `🔄 Código reenviado (${sel})`, cycle);
            reenvioClicado = true;
            break;
          }
        } catch { /* tenta próximo */ }
      }
      if (!reenvioClicado) {
        globalState.addLog('warn', '⚠️ Botão de reenvio não encontrado — aguardando mesma caixa...', cycle);
      }
      await humanPause(randInt(2000, 4000));
    }
  }

  throw new Error(`OTP não recebido após ${MAX_TENTATIVAS} tentativas (${(JANELA_MS * MAX_TENTATIVAS) / 1000}s total)`);
}

// ─── Foto do perfil + KYC ─────────────────────────────────────────────────────

async function clicarFotoPerfil(p: Page, cycle: number, context: BrowserContext): Promise<void> {
  globalState.addLog('info', '📸 Aguardando tela de lista de requisitos (Foto do perfil)...', cycle);

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

  const SELETORES_TIRAR = [
    '[data-dgui="button"]:has-text("Tirar foto")',
    'button:has-text("Tirar foto")',
    'button:has-text("Usar meu telefone")',
    'button:has-text("Enviar foto")',
    'button:has-text("Escolher foto")',
    '[data-testid="step-bottom-navigation"] button',
    '[data-testid="step-bottom-navigation"] [data-dgui="button"]',
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
            await humanPause(randInt(200, 400));
          }
          await el.click({ force: true, timeout: 5000 });
          globalState.addLog('info', `📸 "Foto do perfil" clicado (${sel})`, cycle);
          clicouItem = true;
          break;
        }
      } catch { /* tenta próximo seletor */ }
    }
    if (clicouItem) break;
    await humanPause(1500);
  }

  if (!clicouItem) {
    globalState.addLog('warn', '⚠️ "Foto do perfil" não encontrado após 20s, pulando...', cycle);
    return;
  }

  await humanPause(randInt(1500, 2500));

  let botaoFotoClicado = false;
  for (let tentativa = 0; tentativa < 6; tentativa++) {
    for (const sel of SELETORES_TIRAR) {
      try {
        const el = p.locator(sel).first();
        const visivel = await el.isVisible({ timeout: 2000 }).catch(() => false);
        if (visivel) {
          const box = await el.boundingBox().catch(() => null);
          if (box) {
            await humanMouseMove(p, box.x + box.width / 2, box.y + box.height / 2);
            await humanPause(randInt(300, 600));
          }
          await el.click({ force: true, timeout: 5000 });
          globalState.addLog('info', `📸 Botão foto clicado (${sel})`, cycle);
          botaoFotoClicado = true;
          break;
        }
      } catch { /* tenta próximo */ }
    }
    if (botaoFotoClicado) break;
    if (tentativa > 0 && tentativa % 2 === 0) {
      try {
        await p.evaluate('window.scrollBy(0, 200)');
        globalState.addLog('info', '📸 Scroll aplicado para revelar botão de foto', cycle);
      } catch { /* ignora */ }
    }
    await humanPause(2500);
  }

  if (!botaoFotoClicado) {
    globalState.addLog('warn', '⚠️ Botão de foto não encontrado após 6 tentativas', cycle);
  }

  const detectarEFechar = async (provider: string, score: number, url: string): Promise<void> => {
    if (provider === 'Veriff') {
      globalState.addLog('info', `🗑️ Veriff detectado (score=${score}) → fechando aba para liberar RAM`, cycle);
      await humanPause(randInt(500, 1000));
      await context.close().catch(() => {});
      contextosPorCiclo.delete(cycle);
    } else {
      globalState.addLog('success', `🟢 ${provider} detectado (score=${score}, url=${url}) → aba mantida aberta`, cycle);
    }
  };

  globalState.addLog('info', '⏳ Aguardando KYC inicializar (até 30s)...', cycle);
  const fimKyc1 = Date.now() + 30_000;
  while (Date.now() < fimKyc1) {
    const dominante = resolverProviderDominante(cycle, 4);
    if (dominante) {
      globalState.addLog('info', `✅ KYC detectado: ${dominante.provider} (score=${dominante.score})`, cycle);
      await detectarEFechar(dominante.provider, dominante.score, dominante.url);
      return;
    }
    await humanPause(1000);
  }

  globalState.addLog('warn', '⚠️ KYC não detectado em 30s — tentando re-clique após scroll...', cycle);
  try {
    await p.evaluate('window.scrollTo(0, 0)');
    await humanPause(randInt(500, 1000));
    for (const sel of SELETORES_ITEM) {
      try {
        const el = p.locator(sel).first();
        const visivel = await el.isVisible({ timeout: 1500 }).catch(() => false);
        if (visivel) {
          await el.click({ force: true, timeout: 5000 });
          globalState.addLog('info', `📸 Re-clique em "Foto do perfil" (${sel})`, cycle);
          break;
        }
      } catch { /* ignora */ }
    }
    await humanPause(randInt(1500, 2500));
    for (const sel of SELETORES_TIRAR) {
      try {
        const el = p.locator(sel).first();
        const visivel = await el.isVisible({ timeout: 2000 }).catch(() => false);
        if (visivel) {
          await el.click({ force: true, timeout: 5000 });
          globalState.addLog('info', `📸 Re-clique no botão de foto (${sel})`, cycle);
          break;
        }
      } catch { /* ignora */ }
    }
    const fimKyc2 = Date.now() + 20_000;
    while (Date.now() < fimKyc2) {
      const dominante = resolverProviderDominante(cycle, 4);
      if (dominante) {
        globalState.addLog('info', `✅ KYC detectado (re-clique): ${dominante.provider} (score=${dominante.score})`, cycle);
        await detectarEFechar(dominante.provider, dominante.score, dominante.url);
        return;
      }
      await humanPause(1000);
    }
  } catch (e) {
    globalState.addLog('warn', `⚠️ Erro no re-clique: ${e}`, cycle);
  }

  globalState.addLog('warn', '⚠️ KYC não detectado após re-clique. Aba mantida aberta para inspeção.', cycle);
}

// ─── Stealth script ───────────────────────────────────────────────────────────

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
        arr.item = () => null;
        arr.namedItem = () => null;
        arr.refresh = () => {};
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

// ─── Registra listeners ───────────────────────────────────────────────────────

function registrarListenersFrame(frame: Frame, cycle: number): void {
  try {
    const url = frame.url();
    const provider = detectKycProvider(url);
    if (provider) globalState.addKycSignal(provider, 'frame-url', 5, cycle, url);
  } catch { /* ignora */ }
}

function registrarListenersPage(page: Page, cycle: number): void {
  try {
    for (const frame of page.frames()) {
      registrarListenersFrame(frame, cycle);
    }
  } catch { /* ignora */ }

  page.on('frameattached', (frame) => {
    registrarListenersFrame(frame, cycle);
  });

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

// ─── Aplica CDP mobile em uma página ──────────────────────────────────────────

async function aplicarCDPMobile(page: Page, cycle: number, label = ''): Promise<void> {
  try {
    await page.setViewportSize({ width: MOBILE_WIDTH, height: MOBILE_HEIGHT });

    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      mobile: true,
      width: MOBILE_WIDTH,
      height: MOBILE_HEIGHT,
      deviceScaleFactor: MOBILE_DPR,
      screenOrientation: { angle: 0, type: 'portraitPrimary' },
    });
    await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
    await cdp.send('Emulation.setUserAgentOverride', {
      userAgent: MOBILE_UA,
      acceptLanguage: 'pt-BR,pt;q=0.9',
      platform: 'iPhone',
    });
    await cdp.send('Emulation.setEmitTouchEventsForMouse', { enabled: true, configuration: 'mobile' }).catch(() => {});

    const tag = label ? ` [${label}]` : '';
    globalState.addLog('info', `📱 CDP mobile aplicado${tag} (${MOBILE_WIDTH}x${MOBILE_HEIGHT} @${MOBILE_DPR}x, iPhone 14 UA)`, cycle);
  } catch (e) {
    globalState.addLog('warn', `⚠️ CDP mobile falhou${label ? ` [${label}]` : ''}: ${e}`, cycle);
  }
}

// ─── Cria contexto isolado ────────────────────────────────────────────────────

async function criarContextoIsolado(
  cycle: number
): Promise<{ context: BrowserContext; page: Page }> {
  const proxy = globalState.getProxyForCycle(cycle);

  const context = await browser!.newContext({
    ...MOBILE_DEVICE,
    locale: 'pt-BR',
    timezoneId: 'America/Sao_Paulo',
    geolocation: { latitude: -23.5505, longitude: -46.6333 },
    permissions: ['geolocation'],
    extraHTTPHeaders: {
      'Accept-Language': 'pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7',
    },
    ...(proxy ? { proxy: { server: proxy.server, username: proxy.username, password: proxy.password } } : {}),
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

  await aplicarCDPMobile(page, cycle, 'página principal');

  registrarListenersPage(page, cycle);

  context.on('page', async (novaPage) => {
    const url = novaPage.url() || '(carregando...)';
    globalState.addLog('info', `📌 Nova aba/popup: ${url} — aplicando mobile...`, cycle);

    await aplicarCDPMobile(novaPage, cycle, `popup:${url.slice(0, 40)}`);
    registrarListenersPage(novaPage, cycle);

    novaPage.once('domcontentloaded', async () => {
      await aplicarCDPMobile(novaPage, cycle, `popup-dce:${novaPage.url().slice(0, 40)}`).catch(() => {});
    });
  });

  if (proxy) {
    globalState.addLog('info', `🔁 Proxy ativo: ${proxy.server}`, cycle);
  }

  contextosPorCiclo.set(cycle, context);
  return { context, page };
}

// ─── Flow principal ───────────────────────────────────────────────────────────

export class MockPlaywrightFlow {
  static async init(headless = false): Promise<void> {
    if (browser) {
      globalState.addLog('info', '🦁 Browser já está rodando — próximo ciclo abrirá nova aba');
      return;
    }
    if (browserLaunching) {
      globalState.addLog('info', '⏳ Aguardando browser iniciar (outro ciclo já está subindo)...');
      const deadline = Date.now() + 30_000;
      while (!browser && Date.now() < deadline) {
        await new Promise<void>((r) => setTimeout(r, 200));
      }
      if (!browser) throw new Error('Timeout aguardando browser iniciar');
      return;
    }
    browserLaunching = true;
    try {
      globalState.addLog('info', '🦁 Iniciando Brave...');
      browser = await chromiumExtra.launch({
        headless,
        executablePath: BRAVE_PATH,
        slowMo: 0,
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-blink-features=AutomationControlled',
          '--disable-infobars',
          '--disable-dev-shm-usage',
          '--no-first-run',
          '--no-default-browser-check',
        ],
      }) as unknown as Browser;
      globalState.addLog('info', '✅ Browser pronto — cada ciclo abrirá uma aba com emulação iPhone 14 via CDP');
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

    globalState.addLog('info', `🆕 Ciclo #${cycle}: abrindo nova aba (sessão isolada, mobile iPhone 14)`, cycle);
    const { context, page: p } = await criarContextoIsolado(cycle);

    const client = createEmailClient(config.emailProvider, config.tempMailApiKey);

    try {
      await p.goto(cadastroUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
      // Aguarda estabilizar — networkidle com fallback para não travar em páginas com polling
      await p.waitForLoadState('networkidle', { timeout: 12000 }).catch(() => {});
      await humanPause(randInt(1200, 2000));
      globalState.addLog('info', '🌐 Página de cadastro aberta', cycle);

      const emailAccount = await client.createRandomEmail();
      const payload = gerarPayloadCompleto(emailAccount, config.inviteCode);
      globalState.addLog('info', `👤 ${payload.nome} ${payload.sobrenome} | ${payload.email}`, cycle);

      await humanType(p, '#PHONE_NUMBER_or_EMAIL_ADDRESS', payload.email);
      await humanPause(randInt(config.extraDelay, config.extraDelay + 400));
      await humanClick(p, '#forward-button');
      globalState.addLog('info', '📧 Email preenchido → Continuar', cycle);

      const otp = await aguardarOTPComRetry(p, client, payload.email, config.otpTimeout, cycle);
      await humanPause(randInt(800, 1400));
      const digits = otp.replace(/\D/g, '').split('');
      for (let i = 0; i < digits.length; i++) {
        await humanType(p, `#EMAIL_OTP_CODE-${i}`, digits[i]!);
        await humanPause(randInt(50, 120));
      }
      await humanPause(randInt(config.extraDelay, config.extraDelay + 300));
      await humanClick(p, '#forward-button');
      globalState.addLog('info', '✅ OTP preenchido → Avançar', cycle);

      await humanPause(randInt(400, 900));
      await humanType(p, '#PHONE_NUMBER', payload.telefone);
      await humanPause(randInt(config.extraDelay, config.extraDelay + 300));
      await humanClick(p, '#forward-button');
      globalState.addLog('info', `📱 Telefone: ${payload.telefone}`, cycle);

      await humanPause(randInt(400, 900));
      await humanType(p, '#PASSWORD', payload.senha);
      await humanPause(randInt(config.extraDelay, config.extraDelay + 300));
      await humanClick(p, '#forward-button');
      globalState.addLog('info', '🔒 Senha preenchida', cycle);

      await humanPause(randInt(400, 900));
      await humanType(p, '#FIRST_NAME', payload.nome);
      await humanPause(randInt(200, 400));
      await humanType(p, '#LAST_NAME', payload.sobrenome);
      await humanPause(randInt(config.extraDelay, config.extraDelay + 300));
      await humanClick(p, '#forward-button');
      globalState.addLog('info', `👤 Nome: ${payload.nome} ${payload.sobrenome}`, cycle);

      await aceitarTermos(p);
      await humanPause(randInt(config.extraDelay, config.extraDelay + 400));
      await humanClick(p, '#forward-button');

      await p.waitForURL('**/bonjour.uber.com/**', { timeout: 40000 });
      await humanPause(randInt(700, 1400));
      globalState.addLog('info', '🔄 Redirecionado para bonjo', cycle);

      await dispensarCookies(p);
      await selecionarCidade(p, payload.localizacao, cycle);
      await dispensarCookies(p);

      await humanTypeForce(p, '[data-testid="signup-step::invite-code-input"]', payload.codigoIndicacao);
      await humanPause(randInt(config.extraDelay, config.extraDelay + 400));
      await dispensarCookies(p);
      await humanClick(p, '[data-testid="submit-button"]');
      globalState.addLog('info', `📍 Cidade: ${payload.localizacao} | Convite: ${payload.codigoIndicacao}`, cycle);

      await dispensarWhatsApp(p, cycle);
      await clicarFotoPerfil(p, cycle, context);

      const aindaAberta = contextosPorCiclo.has(cycle);
      if (aindaAberta) {
        globalState.addLog('success', `🎉 Ciclo #${cycle} COMPLETO! Aba mantida aberta.`, cycle);
      } else {
        globalState.addLog('info', `✅ Ciclo #${cycle} concluído!`, cycle);
      }

    } catch (error) {
      await ArtifactsManager.saveScreenshot(p, cycle, 'error').catch(() => {});
      await ArtifactsManager.saveHTML(p, cycle, 'error').catch(() => {});
      throw error;
    }
  }

  static async cleanup(): Promise<void> {
    for (const [cycle, ctx] of contextosPorCiclo.entries()) {
      await ctx.close().catch(() => {});
      globalState.addLog('info', `🗑️ Aba do ciclo #${cycle} fechada`);
    }
    contextosPorCiclo.clear();
    await browser?.close().catch(() => {});
    browser = null;
    globalState.addLog('info', '🧹 Browser fechado');
  }
}
