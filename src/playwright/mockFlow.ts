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

// ─── Primitivas de aleatoriedade ──────────────────────────────────────────────

function randInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function randFloat(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

// Box-Muller com clamp: evita valores extremos que desviam demais da média
function randNormal(mean: number, stdDev: number): number {
  const u1 = Math.random();
  const u2 = Math.random();
  const z = Math.sqrt(-2.0 * Math.log(u1 + 1e-10)) * Math.cos(2 * Math.PI * u2);
  const raw = mean + z * stdDev;
  // Clamp em ±2.5 desvios para evitar delays absurdos
  return Math.round(Math.max(mean - 2.5 * stdDev, Math.min(mean + 2.5 * stdDev, raw)));
}

// ─── Pausas ───────────────────────────────────────────────────────────────────

async function humanPause(baseMs: number): Promise<void> {
  const effective = sp(baseMs);
  const jitter = randInt(-Math.floor(effective * 0.15), Math.floor(effective * 0.2));
  await new Promise<void>((r) => setTimeout(r, Math.max(30, effective + jitter)));
}

// Pausa cognitiva aprimorada:
// – 15% distração curta (leitura lenta)
// – 5% distração longa (usuário sai do foco, volta)
async function cogPause(minMs: number, maxMs: number): Promise<void> {
  const base = randInt(minMs, maxMs);
  let extra = 0;
  const roll = Math.random();
  if (roll < 0.05) {
    // Distração longa: usuário abriu outra coisa (2-5s)
    extra = randInt(2000, 5000);
  } else if (roll < 0.20) {
    // Distração curta: releitura rápida (700-2200ms)
    extra = randInt(700, 2200);
  }
  await humanPause(base + extra);
}

// Pausa de "micro-reflexo" — delay humano mínimo entre ações sequenciais
async function reflexPause(): Promise<void> {
  await new Promise<void>((r) => setTimeout(r, randNormal(55, 18)));
}

// ─── Movimento de mouse: Bézier cúbica + ease-in-out + micro-tremor ───────────
// O Arkose analisa a trajetória do cursor. Retas = robô.

async function humanMouseMove(p: Page, x: number, y: number): Promise<void> {
  const fast = isSpeedMode();

  const startX = randInt(30, 360);
  const startY = randInt(80, 500);

  // Pontos de controle com variação orgânica maior — curvas irregulares
  const cp1X = startX + (x - startX) * randFloat(0.12, 0.40) + randInt(-45, 45);
  const cp1Y = startY + (y - startY) * randFloat(0.12, 0.40) + randInt(-30, 30);
  const cp2X = startX + (x - startX) * randFloat(0.60, 0.88) + randInt(-35, 35);
  const cp2Y = startY + (y - startY) * randFloat(0.60, 0.88) + randInt(-22, 22);

  const dist = Math.hypot(x - startX, y - startY);
  const baseSteps = fast ? randInt(5, 8) : randInt(14, 24);
  const totalSteps = Math.max(baseSteps, Math.floor(dist / 28));

  for (let i = 0; i <= totalSteps; i++) {
    const rawT = i / totalSteps;
    // Ease-in-out cúbica
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

    const speedFactor = Math.sin(Math.PI * rawT);
    const stepDelay = fast
      ? Math.max(1, Math.round(4 * (1 - speedFactor * 0.7)))
      : Math.max(3, Math.round(randNormal(14, 5) * (1 - speedFactor * 0.6)));
    await new Promise<void>((r) => setTimeout(r, stepDelay));
  }

  // Micro-tremor pós-chegada com intensidade variável
  if (!fast) {
    const tremors = randInt(2, 6);
    const intensity = randFloat(1.5, 4.0); // intensidade orgânica
    for (let j = 0; j < tremors; j++) {
      await p.mouse.move(
        x + Math.round(randFloat(-intensity, intensity)),
        y + Math.round(randFloat(-intensity, intensity))
      );
      await new Promise<void>((r) => setTimeout(r, randInt(18, 65)));
    }
    await p.mouse.move(x, y);
    await new Promise<void>((r) => setTimeout(r, randInt(40, 110)));
  }
}

// ─── Hover realista ───────────────────────────────────────────────────────────

async function hoverElement(p: Page, selector: string): Promise<void> {
  try {
    const box = await p.locator(selector).boundingBox().catch(() => null);
    if (!box) return;
    // Aproximação por borda — simula olho encontrando o elemento
    const nearX = Math.round(box.x + box.width * randFloat(0.08, 0.28));
    const nearY = Math.round(box.y + box.height * randFloat(0.25, 0.75));
    await humanMouseMove(p, nearX, nearY);
    await new Promise<void>((r) => setTimeout(r, randInt(60, 180)));
    // Centraliza no elemento — decisão de clicar
    const clickX = Math.round(box.x + box.width * randFloat(0.32, 0.68));
    const clickY = Math.round(box.y + box.height * randFloat(0.32, 0.68));
    await humanMouseMove(p, clickX, clickY);
    await humanPause(randInt(sp(180), sp(420)));
  } catch { /* ignora */ }
}

// ─── Scroll inercial ──────────────────────────────────────────────────────────

async function scrollInercial(p: Page, totalDelta: number): Promise<void> {
  const steps = randInt(4, 10);
  const deltas: number[] = [];
  let remaining = totalDelta;
  for (let i = 0; i < steps; i++) {
    const progress = (i + 1) / steps;
    const eased = Math.sin(progress * Math.PI / 2);
    const portion = i === steps - 1
      ? remaining
      : Math.round(totalDelta * (eased / steps) * randFloat(0.65, 1.35));
    deltas.push(Math.min(portion, remaining));
    remaining -= deltas[deltas.length - 1]!;
  }
  for (const d of deltas) {
    if (d !== 0) await p.mouse.wheel(0, d);
    await new Promise<void>((r) => setTimeout(r, randInt(14, 52)));
  }
}

async function scrollIdle(p: Page): Promise<void> {
  if (isSpeedMode()) return;
  const amount = randInt(70, 220);
  await humanPause(randInt(500, 1100));
  await scrollInercial(p, amount);
  await humanPause(randInt(350, 850));
  await scrollInercial(p, -amount);
  await humanPause(randInt(180, 550));
}

// ─── Click com touch events reais (anti-Arkose) ───────────────────────────────
// O Arkose valida a cadeia de eventos: pointerenter → pointermove → pointerdown
// → touchstart → touchend → pointerup → click.

async function dispatchTouchClick(p: Page, x: number, y: number): Promise<void> {
  await p.evaluate(({ cx, cy }: { cx: number; cy: number }) => {
    const radiusX = 9 + Math.random() * 10;
    const radiusY = 9 + Math.random() * 10;
    const force   = 0.35 + Math.random() * 0.45;
    const angle   = Math.random() * 35 - 17;
    const el = document.elementFromPoint(cx, cy) ?? document.body;

    const mkTouch = (type: string) => {
      const touch = new Touch({
        identifier: Date.now() + Math.floor(Math.random() * 100),
        target: el,
        clientX: cx + (Math.random() - 0.5) * 3,
        clientY: cy + (Math.random() - 0.5) * 3,
        screenX: cx,
        screenY: cy,
        pageX: cx,
        pageY: cy,
        radiusX,
        radiusY,
        rotationAngle: angle,
        force,
      });
      el.dispatchEvent(new TouchEvent(type, {
        bubbles: true, cancelable: true, composed: true,
        touches: type === 'touchend' ? [] : [touch],
        targetTouches: type === 'touchend' ? [] : [touch],
        changedTouches: [touch],
      }));
    };

    mkTouch('touchstart');
    // Micro-movimentos do dedo — pressão natural
    setTimeout(() => mkTouch('touchmove'), 15 + Math.random() * 25);
    setTimeout(() => mkTouch('touchmove'), 35 + Math.random() * 30);
    setTimeout(() => mkTouch('touchend'),  65 + Math.random() * 90);
  }, { cx: x, cy: y });
}

// ─── humanClick: mouse + touch events + press duration realista ───────────────

async function humanClick(p: Page, selector: string): Promise<void> {
  await p.waitForSelector(selector, { state: 'visible', timeout: 15000 });
  const box = await p.locator(selector).boundingBox().catch(() => null);

  if (box) {
    const tx = Math.round(box.x + box.width  * randFloat(0.25, 0.75));
    const ty = Math.round(box.y + box.height * randFloat(0.25, 0.75));

    await humanMouseMove(p, tx, ty);
    // Hover dwell: usuário olha o botão antes de pressionar
    await humanPause(randInt(sp(140), sp(340)));

    // Micro-ajuste final da mão — mão não fica perfeitamente parada
    if (!isSpeedMode()) {
      await p.mouse.move(tx + randInt(-3, 3), ty + randInt(-3, 3));
      await new Promise<void>((r) => setTimeout(r, randInt(18, 55)));
      await p.mouse.move(tx, ty);
      await new Promise<void>((r) => setTimeout(r, randInt(15, 40)));
    }

    // Dispara touch events reais antes do mousedown
    await dispatchTouchClick(p, tx, ty);
    await new Promise<void>((r) => setTimeout(r, randInt(12, 38)));

    await p.mouse.down();
    // Press duration com distribuição normal (humanos variam 60-200ms)
    await new Promise<void>((r) => setTimeout(r, randNormal(105, 28)));
    await p.mouse.up();

    // Mão afasta levemente após click — fingerprint natural
    if (!isSpeedMode()) {
      await reflexPause();
      await p.mouse.move(tx + randInt(-8, 8), ty + randInt(-5, 5));
    }
  } else {
    await p.click(selector);
  }
}

// ─── Micro-hesitação pré-forward-button ───────────────────────────────────────
// Simula o padrão: usuário olha o campo → olha o botão → volta ao campo
// → decide submeter. Esse ping-pong de foco é característico de humanos.

async function microHesitate(p: Page): Promise<void> {
  if (isSpeedMode()) return;
  try {
    const btnBox = await p.locator('#forward-button').boundingBox().catch(() => null);
    if (!btnBox) return;
    const btnCX = btnBox.x + btnBox.width  * randFloat(0.35, 0.65);
    const btnCY = btnBox.y + btnBox.height * randFloat(0.35, 0.65);
    // Move para o botão
    await humanMouseMove(p, btnCX, btnCY);
    await humanPause(randInt(160, 380));
    // Recua levemente — hesitação genuína
    await humanMouseMove(p, btnCX + randInt(-40, 40), btnCY - randInt(18, 65));
    await humanPause(randInt(100, 260));
    // Pausa de reflexão — 30% chance de olhar para trás no formulário
    if (Math.random() < 0.30) {
      await humanMouseMove(p, randInt(60, 320), randInt(120, 380));
      await humanPause(randInt(200, 500));
    }
    // Retorna ao botão com convicção
    await humanMouseMove(p, btnCX, btnCY);
    await humanPause(randInt(90, 220));
  } catch { /* ignora */ }
}

// ─── Forward button ───────────────────────────────────────────────────────────

async function clickForwardButton(p: Page, cycle: number): Promise<void> {
  log('info', '⏳ Aguardando #forward-button habilitado...', cycle);
  await p.waitForSelector('#forward-button:not([disabled])', { state: 'visible', timeout: 15000 }).catch(() => {
    log('warn', '⚠️ #forward-button:not([disabled]) não encontrado, tentando mesmo assim...', cycle);
  });
  if (!isSpeedMode()) {
    await cogPause(500, 1400);
    await microHesitate(p);
  }
  await humanClick(p, '#forward-button');
  log('info', '🖱️ #forward-button clicado', cycle);
}

// ─── Aquecimento de página ────────────────────────────────────────────────────
// O Arkose pontua interações ANTES do submit. Mais histórico = maior score.

async function pageWarmup(p: Page, cycle: number): Promise<void> {
  if (isSpeedMode()) {
    await humanPause(randInt(400, 900));
    return;
  }
  log('info', '🔥 Aquecendo página (simulando leitura inicial)...', cycle);

  // Fase 1: movimentos de leitura em ziguezague (olhos varrem o formulário)
  const pontosLeitura = [
    { x: randInt(50, 180),  y: randInt(55,  130) },
    { x: randInt(180, 340), y: randInt(100, 200) },
    { x: randInt(60,  250), y: randInt(200, 320) },
    { x: randInt(150, 340), y: randInt(300, 420) },
    { x: randInt(60,  220), y: randInt(400, 520) },
  ];
  for (const pt of pontosLeitura) {
    await humanMouseMove(p, pt.x, pt.y);
    await humanPause(randInt(160, 460));
  }

  // Fase 2: scroll de leitura + idle
  await scrollIdle(p);

  // Fase 3: hover no campo de input (usuário "localiza" onde vai digitar)
  try {
    const inputBox = await p.locator('#PHONE_NUMBER_or_EMAIL_ADDRESS').boundingBox().catch(() => null);
    if (inputBox) {
      const cx = inputBox.x + inputBox.width  * 0.5;
      const cy = inputBox.y + inputBox.height * 0.5;
      // Aproxima em dois passos — como um olho que lê e depois foca
      await humanMouseMove(p, cx + randInt(-50, 50), cy + randInt(-30, 30));
      await humanPause(randInt(280, 650));
      await humanMouseMove(p, cx + randInt(-15, 15), cy + randInt(-8, 8));
      await humanPause(randInt(220, 550));

      // Fase 4: hover no botão e volta — indecisão típica
      const btnBox = await p.locator('#forward-button').boundingBox().catch(() => null);
      if (btnBox) {
        await humanMouseMove(p, btnBox.x + btnBox.width * randFloat(0.3, 0.7), btnBox.y + btnBox.height * 0.5);
        await humanPause(randInt(180, 460));
        await humanMouseMove(p, cx, cy);
        await humanPause(randInt(300, 700));
      }
    }
  } catch { /* ignora */ }

  // Fase 5: distração — 35% de chance de scroll extra
  if (Math.random() < 0.35) {
    await scrollIdle(p);
    await humanPause(randInt(300, 700));
  }

  // Fase 6: pausa final — "usuário decide começar a digitar"
  await cogPause(800, 2200);
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
  await hoverElement(p, INPUT_SEL);
  await p.click(INPUT_SEL);
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
        const opcaoBox = aw