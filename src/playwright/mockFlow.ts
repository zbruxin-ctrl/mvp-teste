import { chromium as chromiumExtra } from 'playwright-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import { Browser, Page, BrowserContext } from 'playwright';
import { globalState } from '../state/globalState';
import { TempMailClient } from '../tempMail/client';
import { gerarPayloadCompleto } from '../utils/dataGenerators';
import { ArtifactsManager } from '../utils/artifacts';

chromiumExtra.use(StealthPlugin());

let browser: Browser | null = null;
const contextosPorCiclo = new Map<number, BrowserContext>();

const BRAVE_PATH = 'C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe';
const BRAVE_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.6367.202 Safari/537.36';

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
  const startX = randInt(200, 800);
  const startY = randInt(200, 500);
  const cpX = startX + (x - startX) * 0.4 + randInt(-40, 40);
  const cpY = startY + (y - startY) * 0.4 + randInt(-30, 30);
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const bx = Math.round((1 - t) * (1 - t) * startX + 2 * (1 - t) * t * cpX + t * t * x);
    const by = Math.round((1 - t) * (1 - t) * startY + 2 * (1 - t) * t * cpY + t * t * y);
    await p.mouse.move(bx, by);
    await humanPause(randInt(5, 12));
  }
}

async function humanType(p: Page, selector: string, value: string): Promise<void> {
  await p.waitForSelector(selector, { state: 'visible', timeout: 15000 });
  const box = await p.locator(selector).boundingBox();
  if (box) {
    const tx = Math.round(box.x + box.width * (0.3 + Math.random() * 0.4));
    const ty = Math.round(box.y + box.height * (0.3 + Math.random() * 0.4));
    await humanMouseMove(p, tx, ty);
    await humanPause(randInt(50, 100));
  }
  await p.click(selector);
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
  const box = await p.locator(selector).boundingBox();
  if (box) {
    const tx = Math.round(box.x + box.width * (0.25 + Math.random() * 0.5));
    const ty = Math.round(box.y + box.height * (0.25 + Math.random() * 0.5));
    await humanMouseMove(p, tx, ty);
    await humanPause(randInt(40, 100));
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
          await humanPause(randInt(100, 200));
        }
        await el.click({ timeout: 3000 });
        globalState.addLog('info', `🍪 Banner de cookies dispensado (${seletor})`);
        await humanPause(randInt(300, 600));
        return;
      }
    } catch {
      // ignora e tenta o proximo
    }
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
    async () => {
      await p.click('text=Concordo', { force: true, timeout: 5000 });
    },
  ];

  let aceitou = false;
  for (const tentativa of candidatos) {
    try {
      await tentativa();
      aceitou = true;
      break;
    } catch {
      // tenta o proximo candidato
    }
  }

  if (!aceitou) throw new Error('Nao foi possivel aceitar os termos — nenhum seletor funcionou');
  globalState.addLog('info', '☑️ Termos aceitos');
}

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

// KYC_INIT_SCRIPT — roda no contexto MAIN da página em cada navegação
// Não depende de window.__kycSignal — usa CustomEvent como ponte
const KYC_INIT_SCRIPT = `
  (function() {
    if (window.__kycInjected) return;
    window.__kycInjected = true;

    var PROVIDERS = {
      'Socure':  ['socure', 'devicer.io', 'sigma.socure', 'verify.socure'],
      'Veriff':  ['veriff', 'magic.veriff', 'api.veriff.me', 'cdn.veriff'],
      'Jumio':   ['jumio'],
      'Onfido':  ['onfido'],
      'Persona': ['withpersona', 'persona.id'],
    };

    function analyze(url, source) {
      if (!url || typeof url !== 'string') return;
      var u = url.toLowerCase();
      for (var provider in PROVIDERS) {
        var patterns = PROVIDERS[provider];
        for (var i = 0; i < patterns.length; i++) {
          if (u.indexOf(patterns[i]) !== -1) {
            // Envia para o Node via window.__kycSignal (exposeFunction por page)
            try { window.__kycSignal(provider, source, url, 5); } catch(e) {}
            // Fallback: CustomEvent capturado pelo listener abaixo
            window.dispatchEvent(new CustomEvent('__kyc_hit', { detail: { provider: provider, source: source, url: url } }));
            return;
          }
        }
      }
    }

    // FETCH
    var _fetch = window.fetch;
    window.fetch = function() {
      try { analyze(arguments[0] && (arguments[0].url || arguments[0]), 'fetch'); } catch(e) {}
      return _fetch.apply(this, arguments);
    };

    // XHR
    var _open = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function(method, url) {
      try { analyze(url, 'xhr'); } catch(e) {}
      return _open.apply(this, arguments);
    };

    // WebSocket
    var _WS = window.WebSocket;
    if (_WS) {
      window.WebSocket = function(url, proto) {
        try { analyze(url, 'websocket'); } catch(e) {}
        return proto ? new _WS(url, proto) : new _WS(url);
      };
      window.WebSocket.prototype = _WS.prototype;
    }

    // Script/iframe tags dinâmicas
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

    // MutationObserver — scripts/iframes via innerHTML
    new MutationObserver(function(ms) {
      ms.forEach(function(m) {
        m.addedNodes.forEach(function(n) {
          if (n.tagName && (n.tagName === 'SCRIPT' || n.tagName === 'IFRAME')) {
            analyze(n.src || n.getAttribute('src'), n.tagName.toLowerCase() + '-dom');
          }
        });
      });
    }).observe(document.documentElement, { childList: true, subtree: true });

  })();
`;

async function dispensarWhatsApp(p: Page, cycle: number): Promise<void> {
  await humanPause(randInt(2000, 3500));

  const SELETORES_WHATSAPP = [
    'button:has-text("N\u00c3O ATIVAR")',
    'button:has-text("Nao ativar")',
    'button:has-text("Not now")',
    'button:has-text("Agora n\u00e3o")',
    '[data-testid*="whatsapp"]',
    'button[type="submit"]',
  ];

  const TIMEOUT_MS = 30_000;
  const POLL_MS   = 3_000;
  const inicio    = Date.now();
  let   detectado = false;

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
    'button:has-text("N\u00c3O ATIVAR")',
    'button:has-text("Nao ativar")',
    'button:has-text("Not now")',
    'button:has-text("Agora n\u00e3o")',
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

  globalState.addLog('warn', '⚠️ Tela detectada mas não foi possível clicar em NÃO ATIVAR', cycle);
}

// ─── Fingerprint stealth ───────────────────────────────────────────────────────

const stealthScript = `
  Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  const makePlugin = (name, filename, desc, mimeTypes) => {
    const plugin = Object.create(Plugin.prototype);
    Object.defineProperties(plugin, {
      name: { value: name, enumerable: true },
      filename: { value: filename, enumerable: true },
      description: { value: desc, enumerable: true },
      length: { value: mimeTypes.length, enumerable: true },
    });
    mimeTypes.forEach((mt, i) => {
      const mime = Object.create(MimeType.prototype);
      Object.defineProperties(mime, {
        type: { value: mt.type, enumerable: true },
        suffixes: { value: mt.suffixes, enumerable: true },
        description: { value: mt.description, enumerable: true },
        enabledPlugin: { value: plugin, enumerable: true },
      });
      plugin[i] = mime;
    });
    return plugin;
  };
  const fakePlugins = [
    makePlugin('PDF Viewer', 'internal-pdf-viewer', 'Portable Document Format', [
      { type: 'application/pdf', suffixes: 'pdf', description: 'Portable Document Format' },
      { type: 'text/pdf', suffixes: 'pdf', description: 'Portable Document Format' },
    ]),
    makePlugin('Chrome PDF Viewer', 'internal-pdf-viewer', 'Portable Document Format', [
      { type: 'application/pdf', suffixes: 'pdf', description: 'Portable Document Format' },
    ]),
    makePlugin('Chromium PDF Viewer', 'internal-pdf-viewer', 'Portable Document Format', [
      { type: 'application/pdf', suffixes: 'pdf', description: 'Portable Document Format' },
    ]),
    makePlugin('Microsoft Edge PDF Viewer', 'internal-pdf-viewer', 'Portable Document Format', [
      { type: 'application/pdf', suffixes: 'pdf', description: 'Portable Document Format' },
    ]),
    makePlugin('WebKit built-in PDF', 'internal-pdf-viewer', 'Portable Document Format', [
      { type: 'application/pdf', suffixes: 'pdf', description: 'Portable Document Format' },
    ]),
  ];
  Object.defineProperty(navigator, 'plugins', {
    get: () => {
      const arr = Object.create(PluginArray.prototype);
      fakePlugins.forEach((p, i) => { arr[i] = p; });
      Object.defineProperty(arr, 'length', { value: fakePlugins.length });
      arr.item = i => fakePlugins[i];
      arr.namedItem = name => fakePlugins.find(p => p.name === name) || null;
      arr.refresh = () => {};
      return arr;
    }
  });
  Object.defineProperty(navigator, 'languages', { get: () => ['pt-BR', 'pt', 'en-US', 'en'] });
  Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => 8 });
  Object.defineProperty(navigator, 'deviceMemory', { get: () => 8 });
  Object.defineProperty(navigator, 'platform', { get: () => 'Win32' });
  Object.defineProperty(navigator, 'maxTouchPoints', { get: () => 0 });
  Object.defineProperty(screen, 'colorDepth', { get: () => 24 });
  Object.defineProperty(screen, 'pixelDepth', { get: () => 24 });
  if (navigator.connection) {
    Object.defineProperty(navigator.connection, 'effectiveType', { get: () => '4g' });
    Object.defineProperty(navigator.connection, 'rtt', { get: () => 50 });
    Object.defineProperty(navigator.connection, 'downlink', { get: () => 10 });
    Object.defineProperty(navigator.connection, 'saveData', { get: () => false });
  }
  if (!window.chrome) window.chrome = {};
  if (!window.chrome.runtime) {
    window.chrome.runtime = { connect: () => ({}), sendMessage: () => {}, id: undefined, OnInstalledReason: {} };
  }
  const _origQuery = window.navigator.permissions.query.bind(navigator.permissions);
  window.navigator.permissions.query = (p) =>
    p.name === 'notifications'
      ? Promise.resolve({ state: Notification.permission, onchange: null })
      : _origQuery(p);
  const _origToString = Function.prototype.toString;
  Function.prototype.toString = function () {
    if (this === window.navigator.permissions.query) return 'function query() { [native code] }';
    return _origToString.call(this);
  };
  const getParameter = WebGLRenderingContext.prototype.getParameter;
  WebGLRenderingContext.prototype.getParameter = function (param) {
    if (param === 37445) return 'Intel Inc.';
    if (param === 37446) return 'Intel Iris OpenGL Engine';
    return getParameter.call(this, param);
  };
  const origToDataURL = HTMLCanvasElement.prototype.toDataURL;
  HTMLCanvasElement.prototype.toDataURL = function (type) {
    const ctx = this.getContext('2d');
    if (ctx) {
      const noise = ctx.createImageData(1, 1);
      noise.data[0] = Math.floor(Math.random() * 3);
      ctx.putImageData(noise, Math.random() * this.width | 0, Math.random() * this.height | 0);
    }
    return origToDataURL.apply(this, arguments);
  };
`;

// ─── KYC patterns ─────────────────────────────────────────────────────────────

const KYC_PATTERNS: Array<{ pattern: RegExp; provider: string }> = [
  { pattern: /socure/i,            provider: 'Socure' },
  { pattern: /devicer\.io/i,       provider: 'Socure' },
  { pattern: /sigma\.socure/i,     provider: 'Socure' },
  { pattern: /verify\.socure/i,    provider: 'Socure' },
  { pattern: /veriff/i,            provider: 'Veriff' },
  { pattern: /magic\.veriff/i,     provider: 'Veriff' },
  { pattern: /api\.veriff\.me/i,   provider: 'Veriff' },
  { pattern: /cdn\.veriff/i,       provider: 'Veriff' },
  { pattern: /jumio/i,             provider: 'Jumio'  },
  { pattern: /onfido/i,            provider: 'Onfido' },
  { pattern: /withpersona/i,       provider: 'Persona'},
];

function detectKycProvider(url: string): string | null {
  for (const { pattern, provider } of KYC_PATTERNS) {
    if (pattern.test(url)) return provider;
  }
  return null;
}

// ─── Cria contexto isolado + injeta KYC detector ──────────────────────────────

async function criarContextoIsolado(
  cycle: number
): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser!.newContext({
    viewport: { width: 1366, height: 768 },
    userAgent: BRAVE_UA,
    locale: 'pt-BR',
    timezoneId: 'America/Sao_Paulo',
    geolocation: { latitude: -23.5505, longitude: -46.6333 },
    permissions: ['geolocation'],
    extraHTTPHeaders: {
      'Accept-Language': 'pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7',
    },
  });

  // Stealth injeta antes do JS da página
  await context.addInitScript({ content: stealthScript });

  // KYC_INIT_SCRIPT no context — roda em TODA página/frame do contexto,
  // incluindo redirecionamentos (ex: bonjour.uber.com → KYC provider)
  await context.addInitScript({ content: KYC_INIT_SCRIPT });

  // Network-route no CONTEXT — cobre todas as páginas e redirecionamentos,
  // não apenas a page inicial. FIX: era page.route antes.
  await context.route('**/*', (route) => {
    const url = route.request().url();
    const provider = detectKycProvider(url);
    if (provider) {
      globalState.addKycSignal(provider, 'network-route', 3, cycle, url);
    }
    route.continue();
  });

  const page = await context.newPage();

  // exposeFunction por page — funciona para a page atual e é re-exposto
  // automaticamente pelo Playwright em cada navegação da mesma page
  await page.exposeFunction(
    '__kycSignal',
    (provider: string, source: string, url: string, weight: number) => {
      globalState.addKycSignal(provider, source, weight, cycle, url);
    }
  );

  // iframes com URL KYC
  page.on('framenavigated', (frame) => {
    const url = frame.url();
    const provider = detectKycProvider(url);
    if (provider) {
      globalState.addKycSignal(provider, 'iframe', 5, cycle, url);
    }
  });

  // WebSocket nativo do Playwright
  page.on('websocket', (ws) => {
    const url = ws.url();
    const provider = detectKycProvider(url);
    if (provider) {
      globalState.addKycSignal(provider, 'websocket-native', 5, cycle, url);
    }
  });

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
        '--window-size=1366,768',
      ],
    }) as unknown as Browser;

    globalState.addLog('info', '✅ Browser pronto — cada ciclo abrirá uma aba nova e a manterá aberta');
  }

  static async execute(
    cadastroUrl: string,
    config: {
      tempMailApiKey: string;
      otpTimeout: number;
      extraDelay: number;
    },
    cycle: number
  ): Promise<void> {
    if (!browser) throw new Error('Browser não inicializado — chame init() primeiro');

    globalState.addLog('info', `🆕 Ciclo #${cycle}: abrindo nova aba (sessão isolada)`, cycle);
    const { page: p } = await criarContextoIsolado(cycle);

    const client = new TempMailClient(config.tempMailApiKey);

    try {
      await p.goto(cadastroUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await humanPause(randInt(800, 1600));
      globalState.addLog('info', '🌐 Página de cadastro aberta', cycle);

      const emailAccount = await client.createRandomEmail();
      const payload = gerarPayloadCompleto(emailAccount);
      globalState.addLog('info', `👤 ${payload.nome} ${payload.sobrenome} | ${payload.email}`, cycle);

      // Etapa 1 — email
      await humanType(p, '#PHONE_NUMBER_or_EMAIL_ADDRESS', payload.email);
      await humanPause(randInt(config.extraDelay, config.extraDelay + 400));
      await humanClick(p, '#forward-button');
      globalState.addLog('info', '📧 Email preenchido → Continuar', cycle);

      // Etapa 2 — OTP
      globalState.addLog('info', '⏳ Aguardando OTP...', cycle);
      const otp = await client.waitForOTP(emailAccount.email, config.otpTimeout);
      globalState.addLog('info', `🔑 OTP recebido: ${otp}`, cycle);
      await humanPause(randInt(600, 1200));
      const digits = otp.replace(/\D/g, '').split('');
      for (let i = 0; i < digits.length; i++) {
        await humanType(p, `#EMAIL_OTP_CODE-${i}`, digits[i]!);
        await humanPause(randInt(50, 120));
      }
      await humanPause(randInt(config.extraDelay, config.extraDelay + 300));
      await humanClick(p, '#forward-button');
      globalState.addLog('info', '✅ OTP preenchido → Avançar', cycle);

      // Etapa 3 — telefone
      await humanPause(randInt(400, 900));
      await humanType(p, '#PHONE_NUMBER', payload.telefone);
      await humanPause(randInt(config.extraDelay, config.extraDelay + 300));
      await humanClick(p, '#forward-button');
      globalState.addLog('info', `📱 Telefone: ${payload.telefone}`, cycle);

      // Etapa 4 — senha
      await humanPause(randInt(400, 900));
      await humanType(p, '#PASSWORD', payload.senha);
      await humanPause(randInt(config.extraDelay, config.extraDelay + 300));
      await humanClick(p, '#forward-button');
      globalState.addLog('info', '🔒 Senha preenchida', cycle);

      // Etapa 5 — nome e sobrenome
      await humanPause(randInt(400, 900));
      await humanType(p, '#FIRST_NAME', payload.nome);
      await humanPause(randInt(200, 400));
      await humanType(p, '#LAST_NAME', payload.sobrenome);
      await humanPause(randInt(config.extraDelay, config.extraDelay + 300));
      await humanClick(p, '#forward-button');
      globalState.addLog('info', `👤 Nome: ${payload.nome} ${payload.sobrenome}`, cycle);

      // Etapa 6 — termos
      await aceitarTermos(p);
      await humanPause(randInt(config.extraDelay, config.extraDelay + 400));
      await humanClick(p, '#forward-button');

      // FASE 2: bonjour.uber.com
      await p.waitForURL('**/bonjour.uber.com/**', { timeout: 20000 });
      await humanPause(randInt(700, 1400));
      globalState.addLog('info', '🔄 Redirecionado para bonjour.uber.com', cycle);

      await dispensarCookies(p);

      // Cidade
      await humanType(p, '[data-testid="flow-type-city-selector-v2-input"]', payload.localizacao);
      await humanPause(randInt(600, 1000));
      await p.keyboard.press('ArrowDown');
      await humanPause(randInt(150, 300));
      await p.keyboard.press('Enter');
      await humanPause(randInt(500, 900));

      await dispensarCookies(p);

      await humanTypeForce(p, '[data-testid="signup-step::invite-code-input"]', payload.codigoIndicacao);
      await humanPause(randInt(config.extraDelay, config.extraDelay + 400));

      await dispensarCookies(p);

      await humanClick(p, '[data-testid="submit-button"]');
      globalState.addLog('info', `📍 Cidade: ${payload.localizacao} | Convite: ${payload.codigoIndicacao}`, cycle);

      // Tela do WhatsApp / KYC
      await dispensarWhatsApp(p, cycle);

      await humanPause(randInt(config.extraDelay, config.extraDelay + 500));
      globalState.addLog('success', `🎉 Ciclo #${cycle} COMPLETO! Aba mantida aberta.`, cycle);

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
