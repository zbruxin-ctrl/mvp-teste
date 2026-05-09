import { chromium as chromiumExtra } from 'playwright-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import { Browser, Page, BrowserContext } from 'playwright';
import { globalState } from '../state/globalState';
import { TempMailClient } from '../tempMail/client';
import { gerarPayloadCompleto } from '../utils/dataGenerators';
import { ArtifactsManager } from '../utils/artifacts';

chromiumExtra.use(StealthPlugin());

let browser: Browser | null = null;
let context: BrowserContext | null = null;
let page: Page | null = null;

const BRAVE_PATH = 'C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe';
const BRAVE_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.6367.202 Safari/537.36';

// ─── Helpers humanos ──────────────────────────────────────────────────────────

function randInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

async function humanPause(baseMs: number): Promise<void> {
  const jitter = randInt(-Math.floor(baseMs * 0.25), Math.floor(baseMs * 0.35));
  await new Promise<void>((r) => setTimeout(r, Math.max(100, baseMs + jitter)));
}

async function humanMouseMove(p: Page, x: number, y: number): Promise<void> {
  const steps = randInt(8, 18);
  const startX = randInt(200, 800);
  const startY = randInt(200, 500);
  const cpX = startX + (x - startX) * 0.4 + randInt(-60, 60);
  const cpY = startY + (y - startY) * 0.4 + randInt(-40, 40);
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const bx = Math.round((1 - t) * (1 - t) * startX + 2 * (1 - t) * t * cpX + t * t * x);
    const by = Math.round((1 - t) * (1 - t) * startY + 2 * (1 - t) * t * cpY + t * t * y);
    await p.mouse.move(bx, by);
    await humanPause(randInt(8, 22));
  }
}

async function humanType(p: Page, selector: string, value: string): Promise<void> {
  await p.waitForSelector(selector, { state: 'visible', timeout: 15000 });
  const box = await p.locator(selector).boundingBox();
  if (box) {
    const tx = Math.round(box.x + box.width * (0.3 + Math.random() * 0.4));
    const ty = Math.round(box.y + box.height * (0.3 + Math.random() * 0.4));
    await humanMouseMove(p, tx, ty);
    await humanPause(randInt(80, 180));
  }
  await p.click(selector);
  await p.fill(selector, '');
  await humanPause(randInt(120, 300));
  for (let i = 0; i < value.length; i++) {
    const ch = value[i]!;
    if (Math.random() < 0.05 && /[a-zA-Z]/.test(ch)) {
      const typo = String.fromCharCode(ch.charCodeAt(0) + (Math.random() > 0.5 ? 1 : -1));
      await p.keyboard.type(typo, { delay: randInt(60, 130) });
      await humanPause(randInt(80, 200));
      await p.keyboard.press('Backspace');
      await humanPause(randInt(60, 150));
    }
    await p.keyboard.type(ch, { delay: randInt(55, 145) });
    if (ch === ' ' || ch === '@' || ch === '.') {
      await humanPause(randInt(150, 400));
    } else if (Math.random() < 0.08) {
      await humanPause(randInt(200, 600));
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
    await humanPause(randInt(60, 180));
    await p.mouse.click(tx, ty);
  } else {
    await p.click(selector);
  }
}

// ─── Fingerprint stealth script ───────────────────────────────────────────────

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

// ─── Flow principal ───────────────────────────────────────────────────────────

export class MockPlaywrightFlow {
  static async init(headless = false): Promise<void> {
    if (browser) {
      globalState.addLog('info', '\uD83E\uDDA1 Reusando browser existente');
      page = await context!.newPage();
      await page.goto('https://bonjour.uber.com/', { waitUntil: 'domcontentloaded', timeout: 30000 });
      return;
    }
    globalState.addLog('info', '\uD83E\uDDA1 Brave iniciando em bonjour.uber.com');

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

    context = await browser.newContext({
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

    await context.addInitScript({ content: stealthScript });

    // Abre a pagina ja em bonjour.uber.com
    page = await context.newPage();
    await page.goto('https://bonjour.uber.com/', { waitUntil: 'domcontentloaded', timeout: 30000 });
    globalState.addLog('info', '\uD83C\uDF10 Aberto em bonjour.uber.com');
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
    if (!page) throw new Error('Playwright n\u00e3o inicializado');

    const client = new TempMailClient(config.tempMailApiKey);
    const p = page;

    try {
      // Navega para o cadastro (pode ser diferente de bonjour.uber.com dependendo do fluxo)
      await p.goto(cadastroUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await humanPause(randInt(1200, 2800));
      globalState.addLog('info', '\uD83C\uDF10 P\u00e1gina de cadastro aberta', cycle);

      const emailAccount = await client.createRandomEmail();
      const payload = gerarPayloadCompleto(emailAccount);
      globalState.addLog('info', `\uD83D\uDC64 ${payload.nome} ${payload.sobrenome} | ${payload.email}`, cycle);

      // Etapa 1 — email
      await humanType(p, '#PHONE_NUMBER_or_EMAIL_ADDRESS', payload.email);
      await humanPause(randInt(config.extraDelay, config.extraDelay + 600));
      await humanClick(p, '#forward-button');
      globalState.addLog('info', '\uD83D\uDCE7 Email preenchido \u2192 Continuar', cycle);

      // Etapa 2 — OTP
      globalState.addLog('info', '\u23F3 Aguardando OTP...', cycle);
      const otp = await client.waitForOTP(emailAccount.email, config.otpTimeout);
      globalState.addLog('info', `\uD83D\uDD11 OTP recebido: ${otp}`, cycle);
      await humanPause(randInt(800, 1800));
      const digits = otp.replace(/\D/g, '').split('');
      for (let i = 0; i < digits.length; i++) {
        await humanType(p, `#EMAIL_OTP_CODE-${i}`, digits[i]!);
        await humanPause(randInt(80, 200));
      }
      await humanPause(randInt(config.extraDelay, config.extraDelay + 500));
      await humanClick(p, '#forward-button');
      globalState.addLog('info', '\u2705 OTP preenchido \u2192 Avan\u00e7ar', cycle);

      // Etapa 3 — telefone
      await humanPause(randInt(600, 1400));
      await humanType(p, '#PHONE_NUMBER', payload.telefone);
      await humanPause(randInt(config.extraDelay, config.extraDelay + 500));
      await humanClick(p, '#forward-button');
      globalState.addLog('info', `\uD83D\uDCF1 Telefone: ${payload.telefone}`, cycle);

      // Etapa 4 — senha
      await humanPause(randInt(500, 1200));
      await humanType(p, '#PASSWORD', payload.senha);
      await humanPause(randInt(config.extraDelay, config.extraDelay + 400));
      await humanClick(p, '#forward-button');
      globalState.addLog('info', '\uD83D\uDD12 Senha preenchida', cycle);

      // Etapa 5 — nome e sobrenome
      await humanPause(randInt(600, 1500));
      await humanType(p, '#FIRST_NAME', payload.nome);
      await humanPause(randInt(300, 700));
      await humanType(p, '#LAST_NAME', payload.sobrenome);
      await humanPause(randInt(config.extraDelay, config.extraDelay + 500));
      await humanClick(p, '#forward-button');
      globalState.addLog('info', `\uD83D\uDC64 Nome: ${payload.nome} ${payload.sobrenome}`, cycle);

      // Etapa 6 — checkbox termos
      await p.waitForSelector('input[type="checkbox"]', { state: 'visible', timeout: 10000 });
      await humanPause(randInt(800, 1600));
      const checkbox = p.locator('input[type="checkbox"]').first();
      const cbBox = await checkbox.boundingBox();
      if (cbBox) {
        await humanMouseMove(p, cbBox.x + cbBox.width / 2, cbBox.y + cbBox.height / 2);
        await humanPause(randInt(100, 250));
      }
      if (!(await checkbox.isChecked())) await checkbox.check();
      await humanPause(randInt(config.extraDelay, config.extraDelay + 600));
      await humanClick(p, '#forward-button');
      globalState.addLog('info', '\u2611\uFE0F Termos aceitos', cycle);

      // FASE 2: bonjour.uber.com
      await p.waitForURL('**/bonjour.uber.com/**', { timeout: 20000 });
      await humanPause(randInt(1000, 2200));
      globalState.addLog('info', '\uD83D\uDD04 Redirecionado para bonjour.uber.com', cycle);

      await humanType(p, '[data-testid="flow-type-city-selector-v2-input"]', payload.localizacao);
      await humanPause(randInt(900, 1500));
      await p.keyboard.press('ArrowDown');
      await humanPause(randInt(200, 400));
      await p.keyboard.press('Enter');
      await humanPause(randInt(500, 900));
      await humanType(p, '[data-testid="signup-step::invite-code-input"]', payload.codigoIndicacao);
      await humanPause(randInt(config.extraDelay, config.extraDelay + 600));
      await humanClick(p, '[data-testid="submit-button"]');
      globalState.addLog('info', `\uD83D\uDCCD Cidade: ${payload.localizacao} | Convite: ${payload.codigoIndicacao}`, cycle);

      await humanPause(randInt(1500, 3000));
      const naoAtivar = p.locator('button:has-text("N\u00c3O ATIVAR")');
      const continuar = p.locator('button:has-text("CONTINUAR")');
      if (await naoAtivar.isVisible().catch(() => false)) {
        await humanClick(p, 'button:has-text("N\u00c3O ATIVAR")');
        globalState.addLog('info', '\uD83D\uDD15 Notifica\u00e7\u00f5es: N\u00c3O ATIVAR', cycle);
      } else if (await continuar.isVisible().catch(() => false)) {
        await humanClick(p, 'button:has-text("CONTINUAR")');
        globalState.addLog('info', '\u25B6\uFE0F Notifica\u00e7\u00f5es: CONTINUAR', cycle);
      } else {
        globalState.addLog('warn', '\u26A0\uFE0F Bot\u00e3o de notifica\u00e7\u00e3o n\u00e3o encontrado, continuando...', cycle);
      }

      await humanPause(randInt(config.extraDelay, config.extraDelay + 800));
      globalState.addLog('success', `\uD83C\uDF89 Ciclo #${cycle} COMPLETO!`, cycle);

    } catch (error) {
      await ArtifactsManager.saveScreenshot(p, cycle, 'error').catch(() => {});
      await ArtifactsManager.saveHTML(p, cycle, 'error').catch(() => {});
      throw error;
    }
  }

  static async cleanup(): Promise<void> {
    await page?.close().catch(() => {});
    await context?.close().catch(() => {});
    await browser?.close().catch(() => {});
    page = null;
    context = null;
    browser = null;
    globalState.addLog('info', '\uD83E\uDDF9 Browser fechado manualmente');
  }
}
