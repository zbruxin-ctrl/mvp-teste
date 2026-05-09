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

// User-Agent real do Brave 1.65 (Chromium 124) no Windows 10
const BRAVE_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.6367.202 Safari/537.36';

async function fillField(p: Page, selector: string, value: string, delay = 80): Promise<void> {
  await p.waitForSelector(selector, { state: 'visible', timeout: 15000 });
  await p.click(selector);
  await p.fill(selector, '');
  await p.type(selector, value, { delay });
}

async function clickBtn(p: Page, selector: string): Promise<void> {
  await p.waitForSelector(selector, { state: 'visible', timeout: 15000 });
  await p.click(selector);
}

// Stealth completo — cobre todas as propriedades que anti-bots checam
const stealthScript = `
  // Webdriver
  Object.defineProperty(navigator, 'webdriver', { get: () => undefined });

  // Plugins reais (simula browser normal)
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

  // Idiomas
  Object.defineProperty(navigator, 'languages', { get: () => ['pt-BR', 'pt', 'en-US', 'en'] });

  // Hardware concurrency e memoria (valores comuns)
  Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => 8 });
  Object.defineProperty(navigator, 'deviceMemory', { get: () => 8 });

  // Platform
  Object.defineProperty(navigator, 'platform', { get: () => 'Win32' });

  // chrome.runtime (simula Brave/Chrome real)
  if (!window.chrome) window.chrome = {};
  if (!window.chrome.runtime) {
    window.chrome.runtime = {
      connect: () => {},
      sendMessage: () => {},
      id: undefined,
    };
  }

  // Permissions API — mascara que automation nao pode pedir permissoes
  const originalQuery = window.navigator.permissions.query.bind(navigator.permissions);
  window.navigator.permissions.query = (parameters) =>
    parameters.name === 'notifications'
      ? Promise.resolve({ state: Notification.permission, onchange: null })
      : originalQuery(parameters);

  // Remove cue de automacao no toString
  const originalFunctionToString = Function.prototype.toString;
  Function.prototype.toString = function() {
    if (this === window.navigator.permissions.query) {
      return 'function query() { [native code] }';
    }
    return originalFunctionToString.call(this);
  };
`;

export class MockPlaywrightFlow {
  static async init(headless = false): Promise<void> {
    if (browser) {
      globalState.addLog('info', '\uD83E\uDDA1 Reusando browser existente');
      page = await context!.newPage();
      return;
    }
    globalState.addLog('info', '\uD83E\uDDA1 Brave iniciando (headed) com stealth refor\u00e7ado');

    browser = await chromiumExtra.launch({
      headless,
      executablePath: BRAVE_PATH,
      slowMo: 80,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-blink-features=AutomationControlled',
        '--disable-infobars',
        '--disable-dev-shm-usage',
        '--no-first-run',
        '--no-default-browser-check',
        '--window-size=1366,768',
        '--start-maximized',
      ],
    }) as unknown as Browser;

    context = await browser.newContext({
      viewport: { width: 1366, height: 768 },
      userAgent: BRAVE_UA,
      locale: 'pt-BR',
      timezoneId: 'America/Sao_Paulo',
      geolocation: { latitude: -23.5505, longitude: -46.6333 }, // Sao Paulo exato
      permissions: ['geolocation'],
      extraHTTPHeaders: {
        'Accept-Language': 'pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7',
      },
    });

    await context.addInitScript({ content: stealthScript });

    page = await context.newPage();
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
      await p.goto(cadastroUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
      globalState.addLog('info', '\uD83C\uDF10 P\u00e1gina aberta', cycle);

      const emailAccount = await client.createRandomEmail();
      const payload = gerarPayloadCompleto(emailAccount);
      globalState.addLog('info', `\uD83D\uDC64 ${payload.nome} ${payload.sobrenome} | ${payload.email}`, cycle);

      // Etapa 1 — email
      await fillField(p, '#PHONE_NUMBER_or_EMAIL_ADDRESS', payload.email, 80);
      await p.waitForTimeout(config.extraDelay);
      await clickBtn(p, '#forward-button');
      globalState.addLog('info', '\uD83D\uDCE7 Email preenchido \u2192 Continuar', cycle);

      // Etapa 2 — OTP
      globalState.addLog('info', '\u23F3 Aguardando OTP...', cycle);
      const otp = await client.waitForOTP(emailAccount.email, config.otpTimeout);
      globalState.addLog('info', `\uD83D\uDD11 OTP recebido: ${otp}`, cycle);
      const digits = otp.replace(/\D/g, '').split('');
      for (let i = 0; i < digits.length; i++) {
        await fillField(p, `#EMAIL_OTP_CODE-${i}`, digits[i]!, 50);
      }
      await p.waitForTimeout(config.extraDelay);
      await clickBtn(p, '#forward-button');
      globalState.addLog('info', '\u2705 OTP preenchido \u2192 Avan\u00e7ar', cycle);

      // Etapa 3 — telefone
      await fillField(p, '#PHONE_NUMBER', payload.telefone, 80);
      await p.waitForTimeout(config.extraDelay);
      await clickBtn(p, '#forward-button');
      globalState.addLog('info', `\uD83D\uDCF1 Telefone: ${payload.telefone}`, cycle);

      // Etapa 4 — senha
      await fillField(p, '#PASSWORD', payload.senha, 80);
      await p.waitForTimeout(config.extraDelay);
      await clickBtn(p, '#forward-button');
      globalState.addLog('info', '\uD83D\uDD12 Senha preenchida', cycle);

      // Etapa 5 — nome e sobrenome
      await fillField(p, '#FIRST_NAME', payload.nome, 80);
      await fillField(p, '#LAST_NAME', payload.sobrenome, 80);
      await p.waitForTimeout(config.extraDelay);
      await clickBtn(p, '#forward-button');
      globalState.addLog('info', `\uD83D\uDC64 Nome: ${payload.nome} ${payload.sobrenome}`, cycle);

      // Etapa 6 — checkbox termos
      await p.waitForSelector('input[type="checkbox"]', { state: 'visible', timeout: 10000 });
      const checkbox = p.locator('input[type="checkbox"]').first();
      if (!(await checkbox.isChecked())) await checkbox.check();
      await p.waitForTimeout(config.extraDelay);
      await clickBtn(p, '#forward-button');
      globalState.addLog('info', '\u2611\uFE0F Termos aceitos', cycle);

      // FASE 2: bonjour.uber.com
      await p.waitForURL('**/bonjour.uber.com/**', { timeout: 20000 });
      globalState.addLog('info', '\uD83D\uDD04 Redirecionado para bonjour.uber.com', cycle);

      await fillField(p, '[data-testid="flow-type-city-selector-v2-input"]', payload.localizacao, 80);
      await p.waitForTimeout(1200);
      await p.keyboard.press('ArrowDown');
      await p.keyboard.press('Enter');
      await p.waitForTimeout(500);
      await fillField(p, '[data-testid="signup-step::invite-code-input"]', payload.codigoIndicacao, 80);
      await p.waitForTimeout(config.extraDelay);
      await clickBtn(p, '[data-testid="submit-button"]');
      globalState.addLog('info', `\uD83D\uDCCD Cidade: ${payload.localizacao} | Convite: ${payload.codigoIndicacao}`, cycle);

      await p.waitForTimeout(2000);
      const naoAtivar = p.locator('button:has-text("N\u00c3O ATIVAR")');
      const continuar = p.locator('button:has-text("CONTINUAR")');
      if (await naoAtivar.isVisible().catch(() => false)) {
        await naoAtivar.click();
        globalState.addLog('info', '\uD83D\uDD15 Notifica\u00e7\u00f5es: N\u00c3O ATIVAR', cycle);
      } else if (await continuar.isVisible().catch(() => false)) {
        await continuar.click();
        globalState.addLog('info', '\u25B6\uFE0F Notifica\u00e7\u00f5es: CONTINUAR', cycle);
      } else {
        globalState.addLog('warn', '\u26A0\uFE0F Bot\u00e3o de notifica\u00e7\u00e3o n\u00e3o encontrado, continuando...', cycle);
      }

      await p.waitForTimeout(config.extraDelay);
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
