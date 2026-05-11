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
const contextosPorCiclo = new Map<number, BrowserContext>();

const BRAVE_PATH = 'C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe';

const MOBILE_DEVICE = devices['iPhone 14'];

// ─── Speed helpers ────────────────────────────────────────────────────────────

function isSpeedMode(): boolean {
  const cfg = globalState.getConfig();
  return !!(cfg as any)?.speedMode;
}

/** Retorna valor reduzido quando speedMode ativo (40% do original) */
function sp(normal: number): number {
  return isSpeedMode() ? Math.max(30, Math.round(normal * 0.4)) : normal;
}

// ─── Helpers humanos ──────────────────────────────────────────────────────────

function randInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

async function humanPause(baseMs: number): Promise<void> {
  const effective = sp(baseMs);
  const jitter = randInt(-Math.floor(effective * 0.15), Math.floor(effective * 0.2));
  await new Promise<void>((r) => setTimeout(r, Math.max(30, effective + jitter)));
}

async function humanMouseMove(p: Page, x: number, y: number): Promise<void> {
  const steps = isSpeedMode() ? randInt(2, 4) : randInt(5, 10);
  const startX = randInt(50, 300);
  const startY = randInt(100, 400);
  const cpX = startX + (x - startX) * 0.4 + randInt(-20, 20);
  const cpY = startY + (y - startY) * 0.4 + randInt(-15, 15);
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const bx = Math.round((1 - t) * (1 - t) * startX + 2 * (1 - t) * t * cpX + t * t * x);
    const by = Math.round((1 - t) * (1 - t) * startY + 2 * (1 - t) * t * cpY + t * t * y);
    await p.mouse.move(bx, by);
    await humanPause(randInt(3, isSpeedMode() ? 6 : 12));
  }
}

async function humanType(p: Page, selector: string, value: string): Promise<void> {
  await p.waitForSelector(selector, { state: 'visible', timeout: 15000 });
  const box = await p.locator(selector).boundingBox();
  if (box) {
    const tx = Math.round(box.x + box.width * (0.3 + Math.random() * 0.4));
    const ty = Math.round(box.y + box.height * (0.3 + Math.random() * 0.4));
    await humanMouseMove(p, tx, ty);
    await humanPause(randInt(sp(50), sp(100)));
  }
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
    const charDelay = fast ? randInt(15, 40) : randInt(35, 90);
    await p.keyboard.type(ch, { delay: charDelay });
    if (!fast) {
      if (ch === ' ' || ch === '@' || ch === '.') {
        await humanPause(randInt(80, 200));
      } else if (Math.random() < 0.05) {
        await humanPause(randInt(100, 300));
      }
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
    await humanPause(randInt(sp(50), sp(100)));
  }
  await p.click(selector, { force: true });
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
    const charDelay = fast ? randInt(15, 40) : randInt(35, 90);
    await p.keyboard.type(ch, { delay: charDelay });
    if (!fast) {
      if (ch === ' ' || ch === '@' || ch === '.') {
        await humanPause(randInt(80, 200));
      } else if (Math.random() < 0.05) {
        await humanPause(randInt(100, 300));
      }
    }
  }
}

async function humanClick(p: Page, selector: string): Promise<void> {
  await p.waitForSelector(selector, { state: 'visible', timeout: 15000 });
  const box = await p.locator(selector).boundingBox();
  if (box) {
    const tx = Math.round(box.x + box.width * (0.25 + Math.random() * 0.5));
    const ty = Math.round(box.y + box.height * (0.25 + Math.random() * 0.5));
    await humanMouseMove(p, tx, ty);
    await humanPause(randInt(sp(40), sp(100)));
    await p.mouse.click(tx, ty);
  } else {
    await p.click(selector);
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

  globalState.addLog('info', `📍 Digitando cidade: "${nomeBusca}"`, cycle);
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

  globalState.addLog('info', '⏳ Aguardando dropdown de cidade...', cycle);
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
    globalState.addLog('warn', '⚠️ Dropdown não detectado, tentando ArrowDown+Enter', cycle);
    await humanPause(randInt(sp(300), sp(600)));
    await p.keyboard.press('ArrowDown');
    await humanPause(randInt(sp(150), sp(300)));
    await p.keyboard.press('Enter');
    return;
  }

  await humanPause(randInt(sp(300), sp(600)));
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
          await humanPause(randInt(sp(150), sp(300)));
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
    await humanPause(randInt(sp(400), sp(800)));

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
            await humanPause(randInt(sp(150), sp(300)));
          }
          await el.click({ timeout: 5000 });
          globalState.addLog('info', `🔕 WhatsApp: NÃO ATIVAR clicado (CSS: ${sel})`, cycle);
          await humanPause(randInt(sp(400), sp(800)));
          return;
        }
      } catch { /* tenta próxima */ }
    }

    try {
      const clicou = await p.evaluate(JS_NAO_ATIVAR) as boolean;
      if (clicou) {
        globalState.addLog('info', '🔕 WhatsApp: NÃO ATIVAR clicado (JS normalize)', cycle);
        await humanPause(randInt(sp(400), sp(800)));
        return;
      }
    } catch { /* ignora */ }

    try {
      const clicou = await p.evaluate(JS_FALLBACK_SUBMIT) as string | null;
      if (clicou) {
        globalState.addLog('info', `🔕 WhatsApp: botão "${clicou}" clicado (fallback submit)`, cycle);
        await humanPause(randInt(sp(400), sp(800)));
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
            await humanPause(randInt(sp(200), sp(400)));
          }
          await el.click({ force: true, timeout: 5000 });
          globalState.addLog('info', `📸 "Foto do perfil" clicado (${sel})`, cycle);
          clicouItem = true;
          break;
        }
      } catch { /* tenta próximo seletor */ }
    }
    if (clicouItem) break;
    await humanPause(isSpeedMode() ? 600 : 1500);
  }

  if (!clicouItem) {
    globalState.addLog('warn', '⚠️ "Foto do perfil" não encontrado após 20s, pulando...', cycle);
    return;
  }

  await humanPause(randInt(sp(1500), sp(2500)));

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
            await humanPause(randInt(sp(300), sp(600)));
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
    await humanPause(isSpeedMode() ? 1000 : 2500);
  }

  if (!botaoFotoClicado) {
    globalState.addLog('warn', '⚠️ Botão de foto não encontrado após 6 tentativas', cycle);
  }

  // ── Salva conta quando Socure confirmado ──────────────────────────────────
  const salvarContaSocure = async (): Promise<void> => {
    const payload = globalState.getPayload(cycle);
    if (!payload) {
      globalState.addLog('warn', '⚠️ Payload não encontrado no globalState — conta não salva', cycle);
      return;
    }
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
      globalState.addLog('success', `💾 Conta salva! id=${saved.id} | ${payload.email}`, cycle);
    } catch (e) {
      globalState.addLog('warn', `⚠️ Erro ao salvar conta: ${e}`, cycle);
    } finally {
      globalState.clearPayload(cycle);
    }
  };

  const detectarEFechar = async (provider: string, score: number, url: string): Promise<void> => {
    if (provider === 'Veriff') {
      globalState.addLog('info', `🗑️ Veriff detectado (score=${score}) → fechando aba para liberar RAM`, cycle);
      await humanPause(randInt(sp(500), sp(1000)));
      await context.close().catch(() => {});
      contextosPorCiclo.delete(cycle);
      globalState.clearPayload(cycle);
    } else {
      globalState.addLog('success', `🟢 ${provider} detectado (score=${score}, url=${url}) → aba mantida aberta`, cycle);
      if (provider === 'Socure') {
        await salvarContaSocure();
      }
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
    await humanPause(isSpeedMode() ? 500 : 1000);
  }

  globalState.addLog('warn', '⚠️ KYC não detectado em 30s — tentando re-clique após scroll...', cycle);
  try {
    await p.evaluate('window.scrollTo(0, 0)');
    await humanPause(randInt(sp(500), sp(1000)));

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
    await humanPause(randInt(sp(1500), sp(2500)));

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
      await humanPause(isSpeedMode() ? 500 : 1000);
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
