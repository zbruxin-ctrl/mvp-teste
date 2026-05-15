/**
 * humanActions.ts
 * Primitivas de interação humana anti-captcha (Arkose / TurnStile / hCaptcha).
 * Centraliza TODOS os timings e movimentos usados pelo mockFlow.
 */

import { Page } from 'playwright';
import { globalState } from '../state/globalState';

// ─── Speed helper ─────────────────────────────────────────────────────────────

export function isSpeedMode(): boolean {
  return !!(globalState.getState().config as any)?.speedMode;
}

/**
 * Ajusta timing para speedMode: mantém um mínimo de 30ms para não gerar
 * padrões de 0ms que são imediatamente detectáveis como bot.
 */
export function sp(normal: number): number {
  return isSpeedMode() ? Math.max(30, Math.round(normal * 0.35) + 20) : normal;
}

// ─── Geradores de números aleatórios ─────────────────────────────────────────

export function randInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

export function randFloat(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

/**
 * Distribuição normal (Box-Muller) — pausas com variância gaussiana são
 * muito mais difíceis de detectar que pausas uniformes.
 */
function gaussianRand(): number {
  let u = 0, v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/** Retorna true se o char pode ser passado para keyboard.down/up sem erro. */
function isAsciiKey(ch: string): boolean {
  const code = ch.charCodeAt(0);
  // Playwright aceita keyboard.down apenas para chars ASCII imprimíveis (32-126)
  // e chars de controle mapeados (ex: Enter, Tab). Para tudo acima de 127
  // (acentuados, ç, ã, etc.) é necessário usar keyboard.type.
  return ch.length === 1 && code >= 32 && code <= 126;
}

// ─── Pausas ───────────────────────────────────────────────────────────────────

/**
 * Pausa com jitter gaussiano em torno do valor base.
 * Evita padrões periódicos detectados por análise estatística de timing.
 */
export async function humanPause(baseMs: number): Promise<void> {
  const effective = sp(baseMs);
  const stddev = effective * 0.12;
  const jitter = clamp(Math.round(gaussianRand() * stddev), -effective * 0.25, effective * 0.25);
  const delay = Math.max(20, effective + jitter);
  await new Promise<void>((r) => setTimeout(r, delay));
}

/**
 * Pausa cognitiva — imita latência de decisão humana.
 * 20% chance de "distração" (pausa 2-4× mais longa).
 */
export async function cogPause(minMs: number, maxMs: number): Promise<void> {
  const base = randInt(sp(minMs), sp(maxMs));
  const skewed = base + Math.max(0, Math.round(gaussianRand() * base * 0.08));
  const distracted = !isSpeedMode() && Math.random() < 0.20
    ? randInt(800, 3200)
    : 0;
  await new Promise<void>((r) => setTimeout(r, Math.max(30, skewed + distracted)));
}

/**
 * Micro-pausa — entre eventos de baixa latência (ex.: entre dígitos do OTP).
 */
export async function microPause(): Promise<void> {
  const base = isSpeedMode() ? randInt(8, 25) : randInt(18, 55);
  await new Promise<void>((r) => setTimeout(r, base));
}

// ─── Movimento de mouse ───────────────────────────────────────────────────────

/**
 * Move o mouse em curva Bézier cúbica com ease-in-out + overshoot leve.
 * Velocidade não-uniforme via seno (mais lento no início e fim).
 * Micro-tremor pós-chegada em modo normal.
 */
export async function humanMouseMove(p: Page, x: number, y: number): Promise<void> {
  const fast = isSpeedMode();
  const startX = randInt(20, 380);
  const startY = randInt(60, 520);

  const overshootX = x + randInt(-8, 8);
  const overshootY = y + randInt(-6, 6);

  const cp1X = startX + (overshootX - startX) * randFloat(0.15, 0.38) + randInt(-40, 40);
  const cp1Y = startY + (overshootY - startY) * randFloat(0.15, 0.38) + randInt(-25, 25);
  const cp2X = startX + (overshootX - startX) * randFloat(0.62, 0.85) + randInt(-25, 25);
  const cp2Y = startY + (overshootY - startY) * randFloat(0.62, 0.85) + randInt(-18, 18);

  const totalSteps = fast ? randInt(5, 9) : randInt(12, 24);

  for (let i = 0; i <= totalSteps; i++) {
    const rawT = i / totalSteps;
    const t = rawT < 0.5
      ? 4 * rawT * rawT * rawT
      : 1 - Math.pow(-2 * rawT + 2, 3) / 2;

    const bx = Math.round(
      Math.pow(1 - t, 3) * startX +
      3 * Math.pow(1 - t, 2) * t * cp1X +
      3 * (1 - t) * t * t * cp2X +
      t * t * t * overshootX
    );
    const by = Math.round(
      Math.pow(1 - t, 3) * startY +
      3 * Math.pow(1 - t, 2) * t * cp1Y +
      3 * (1 - t) * t * t * cp2Y +
      t * t * t * overshootY
    );

    await p.mouse.move(bx, by);

    const speedFactor = Math.sin(Math.PI * rawT);
    const stepDelay = fast
      ? Math.max(2, Math.round(4 * (1 - speedFactor * 0.65)))
      : Math.max(3, Math.round(randInt(7, 20) * (1 - speedFactor * 0.55)));
    await new Promise<void>((r) => setTimeout(r, stepDelay));
  }

  if (!fast && (Math.abs(overshootX - x) > 2 || Math.abs(overshootY - y) > 2)) {
    await p.mouse.move(x + randInt(-1, 1), y + randInt(-1, 1));
    await new Promise<void>((r) => setTimeout(r, randInt(15, 40)));
    await p.mouse.move(x, y);
  }

  if (!fast) {
    const tremors = randInt(1, 4);
    for (let j = 0; j < tremors; j++) {
      await p.mouse.move(x + randInt(-2, 2), y + randInt(-2, 2));
      await new Promise<void>((r) => setTimeout(r, randInt(20, 70)));
    }
    await p.mouse.move(x, y);
  }
}

// ─── Hover ────────────────────────────────────────────────────────────────────

export async function hoverElement(p: Page, selector: string): Promise<void> {
  try {
    const box = await p.locator(selector).first().boundingBox().catch(() => null);
    if (!box) return;
    const hx = Math.round(box.x + box.width  * randFloat(0.25, 0.75));
    const hy = Math.round(box.y + box.height * randFloat(0.28, 0.72));
    await humanMouseMove(p, hx, hy);
    await humanPause(randInt(sp(140), sp(320)));
  } catch { /* ignora */ }
}

// ─── focusField ───────────────────────────────────────────────────────────────
// O Arkose rastreia a cadeia: pointerover → pointerenter → pointermove
// → pointerdown → pointerup → focus. Usar apenas .focus() ou .click()
// pula toda essa cadeia e acende um sinal de automação.

export async function focusField(p: Page, selector: string): Promise<void> {
  const box = await p.locator(selector).first().boundingBox().catch(() => null);
  if (!box) {
    await p.focus(selector).catch(() => {});
    return;
  }

  const targetX = Math.round(box.x + box.width  * randFloat(0.3, 0.7));
  const targetY = Math.round(box.y + box.height * randFloat(0.3, 0.7));

  await humanMouseMove(p, targetX + randInt(-60, 60), targetY + randInt(-40, 40));
  await humanPause(randInt(sp(120), sp(280)));
  await humanMouseMove(p, targetX, targetY);
  await humanPause(randInt(sp(80), sp(180)));

  await p.evaluate(({ cx, cy }: { cx: number; cy: number }) => {
    const el = document.elementFromPoint(cx, cy) as HTMLElement | null;
    if (!el) return;
    const opts = { bubbles: true, cancelable: true, composed: true, clientX: cx, clientY: cy };
    el.dispatchEvent(new PointerEvent('pointerover',  opts));
    el.dispatchEvent(new PointerEvent('pointerenter', { ...opts, bubbles: false }));
    el.dispatchEvent(new PointerEvent('pointermove',  opts));
    el.dispatchEvent(new MouseEvent('mouseover',  opts));
    el.dispatchEvent(new MouseEvent('mouseenter', { ...opts, bubbles: false }));
    el.dispatchEvent(new MouseEvent('mousemove',  opts));
  }, { cx: targetX, cy: targetY });

  await humanPause(randInt(25, 65));
  await p.mouse.down();
  await new Promise<void>((r) => setTimeout(r, randInt(40, 100)));
  await p.mouse.up();
  await humanPause(randInt(sp(100), sp(250)));
}

// ─── _typeChar ────────────────────────────────────────────────────────────────
// FIX: keyboard.down/up falha com "Unknown key" para chars não-ASCII
// (acentuados, ç, ã, etc.). A detecção isAsciiKey() decide o caminho:
//   ASCII (32-126)  → keyboard.down + holdMs + InputEvent + keyboard.up
//   Non-ASCII       → keyboard.type (Playwright converte internamente) +
//                     InputEvent manual para manter a cadeia de eventos.

export async function _typeChar(p: Page, ch: string, fast: boolean): Promise<void> {
  const holdMs = fast
    ? randInt(15, 45)
    : clamp(Math.round(gaussianRand() * 20 + 65), 35, 130);

  if (isAsciiKey(ch)) {
    // Caminho original: down → hold → InputEvent → up
    await p.keyboard.down(ch);
    await new Promise<void>((r) => setTimeout(r, holdMs));
    await p.evaluate((char: string) => {
      const el = document.activeElement as HTMLInputElement | null;
      if (!el) return;
      el.dispatchEvent(new InputEvent('input', {
        bubbles: true,
        cancelable: false,
        composed: true,
        data: char,
        inputType: 'insertText',
        isComposing: false,
      }));
    }, ch);
    await p.keyboard.up(ch);
  } else {
    // Caminho Unicode: keyboard.type insere o char sem exigir nome de tecla
    await p.keyboard.type(ch, { delay: holdMs });
    // Dispara InputEvent adicional para manter compatibilidade com React
    await p.evaluate((char: string) => {
      const el = document.activeElement as HTMLInputElement | null;
      if (!el) return;
      el.dispatchEvent(new InputEvent('input', {
        bubbles: true,
        cancelable: false,
        composed: true,
        data: char,
        inputType: 'insertText',
        isComposing: false,
      }));
    }, ch);
  }
}

// ─── Digitação ────────────────────────────────────────────────────────────────

function sessionWpm(): number {
  if (!(globalThis as any).__humanWpm) {
    (globalThis as any).__humanWpm = randInt(40, 90);
  }
  return (globalThis as any).__humanWpm;
}

function wpmToCharDelay(): number {
  const wpm = sessionWpm();
  return Math.round(60_000 / (wpm * 5));
}

export async function humanType(p: Page, selector: string, value: string): Promise<void> {
  await p.waitForSelector(selector, { state: 'visible', timeout: 15000 });
  await focusField(p, selector);
  await p.fill(selector, '');
  await humanPause(randInt(sp(50), sp(130)));

  const fast = isSpeedMode();
  const baseCharDelay = fast ? randInt(12, 35) : wpmToCharDelay();
  let burstRemaining = randInt(3, 8);

  for (let i = 0; i < value.length; i++) {
    const ch = value[i]!;

    // Guard: só gera typo para ASCII imprimível (32-126) para não produzir
    // chars acentuados via charCodeAt+offset que quebrariam keyboard.down
    if (!fast && Math.random() < 0.04 && /[a-zA-Z]/.test(ch)) {
      const offset = Math.random() > 0.5 ? 1 : -1;
      const typoCode = ch.charCodeAt(0) + offset;
      if (typoCode >= 32 && typoCode <= 126) {
        await _typeChar(p, String.fromCharCode(typoCode), false);
        await humanPause(randInt(40, 100));
        await p.keyboard.press('Backspace');
        await humanPause(randInt(30, 80));
      }
    }

    const charJitter = fast ? 0 : Math.round(gaussianRand() * baseCharDelay * 0.3);
    const charDelay = Math.max(8, baseCharDelay + charJitter);

    await _typeChar(p, ch, fast);
    await new Promise<void>((r) => setTimeout(r, charDelay));

    if (!fast) {
      if (' @._-/'.includes(ch)) await humanPause(randInt(60, 180));
      burstRemaining--;
      if (burstRemaining <= 0) {
        await microPause();
        burstRemaining = randInt(3, 9);
      }
      if (Math.random() < 0.06) await humanPause(randInt(100, 380));
    }
  }
}

/**
 * humanTypeForce — limpa forçosamente e dispara InputEvent após cada caractere.
 * Compatível com React/Vue controlled inputs.
 * Tolerante a campos que desaparecem durante digitação (ex: tela de OTP).
 */
export async function humanTypeForce(p: Page, selector: string, value: string): Promise<void> {
  const appeared = await p.waitForSelector(selector, { state: 'visible', timeout: 15000 })
    .then(() => true)
    .catch(() => false);

  if (!appeared) {
    globalState.addLog('warn', `⚠️ [humanTypeForce] Campo "${selector}" não apareceu — pulando digitação`);
    return;
  }

  await focusField(p, selector);
  await p.keyboard.press('ControlOrMeta+a');
  await humanPause(randInt(25, 55));
  await p.keyboard.press('Delete');
  await humanPause(randInt(sp(50), sp(130)));

  const residual = await p.locator(selector).inputValue().catch(() => '');
  if (residual.length > 0) {
    await p.locator(selector).evaluate((el: HTMLInputElement) => {
      el.value = '';
      el.dispatchEvent(new InputEvent('input', {
        bubbles: true, cancelable: false, composed: true,
        data: '', inputType: 'deleteContentBackward',
      }));
    }).catch(() => {});
    await humanPause(randInt(25, 55));
  }

  const fast = isSpeedMode();
  const baseCharDelay = fast ? randInt(12, 35) : wpmToCharDelay();
  let burstRemaining = randInt(3, 8);

  for (let i = 0; i < value.length; i++) {
    const stillVisible = await p.locator(selector).isVisible().catch(() => false);
    if (!stillVisible) {
      globalState.addLog('info',
        `ℹ️ [humanTypeForce] Campo "${selector}" desapareceu após ${i}/${value.length} chars — OK, navegação detectada`);
      return;
    }

    const ch = value[i]!;

    // Guard: só gera typo para ASCII imprimível (32-126) para não produzir
    // chars acentuados via charCodeAt+offset que quebrariam keyboard.down
    if (!fast && Math.random() < 0.04 && /[a-zA-Z]/.test(ch)) {
      const offset = Math.random() > 0.5 ? 1 : -1;
      const typoCode = ch.charCodeAt(0) + offset;
      if (typoCode >= 32 && typoCode <= 126) {
        await _typeChar(p, String.fromCharCode(typoCode), false);
        await humanPause(randInt(40, 100));
        await p.keyboard.press('Backspace');
        await p.locator(selector).evaluate((el: HTMLInputElement) => {
          el.dispatchEvent(new InputEvent('input', {
            bubbles: true, cancelable: false, composed: true,
            data: null as any, inputType: 'deleteContentBackward',
          }));
        }).catch(() => {});
        await humanPause(randInt(30, 80));
      }
    }

    const charJitter = fast ? 0 : Math.round(gaussianRand() * baseCharDelay * 0.3);
    const charDelay = Math.max(8, baseCharDelay + charJitter);

    await _typeChar(p, ch, fast);
    await new Promise<void>((r) => setTimeout(r, charDelay));

    if (!fast) {
      if (' @._-/'.includes(ch)) await humanPause(randInt(60, 180));
      burstRemaining--;
      if (burstRemaining <= 0) {
        await microPause();
        burstRemaining = randInt(3, 9);
      }
      if (Math.random() < 0.06) await humanPause(randInt(100, 380));
    }
  }

  await humanPause(randInt(sp(200), sp(500)));

  await p.locator(selector).evaluate((el: HTMLInputElement) => {
    el.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));
    el.dispatchEvent(new Event('blur',   { bubbles: true }));
  }).catch(() => {});

  const finalVal = await p.locator(selector).inputValue().catch(() => '(campo sumiu)');
  globalState.addLog('info', `🔍 [DEBUG] Campo "${selector}" → "${finalVal}"`);
}

// ─── Click ────────────────────────────────────────────────────────────────────

export async function humanClick(p: Page, selector: string): Promise<void> {
  await p.waitForSelector(selector, { state: 'visible', timeout: 15000 });
  const box = await p.locator(selector).first().boundingBox();
  if (box) {
    const tx = Math.round(box.x + box.width  * randFloat(0.22, 0.78));
    const ty = Math.round(box.y + box.height * randFloat(0.22, 0.78));
    await humanMouseMove(p, tx, ty);
    await humanPause(randInt(sp(100), sp(300)));
    await p.mouse.down();
    const holdMs = isSpeedMode() ? randInt(30, 80) : randInt(45, 130);
    await new Promise<void>((r) => setTimeout(r, holdMs));
    await p.mouse.up();
    await humanPause(randInt(sp(30), sp(80)));
  } else {
    await p.click(selector);
  }
}

// ─── Forward button ───────────────────────────────────────────────────────────
// FIX: versão tolerante a falhas.
// Antes: waitForSelector lançava exceção se #forward-button não existia na
// tela de localização (Uber usa botão diferente), o que subia até o catch do
// _executarCiclo e fechava o contexto silenciosamente.
// Agora: .catch(() => {}) no waitForSelector + lista de fallback tentada em
// sequência + swallow silencioso se nenhum seletor existir na página.

export async function clickForwardButton(p: Page, cycle: number): Promise<void> {
  globalState.addLog('info', '⏳ Aguardando botão de avançar...', cycle);

  // Aguarda #forward-button habilitado, mas NÃO lança exceção se não existir
  await p.waitForSelector('#forward-button:not([disabled])', { state: 'visible', timeout: 8000 })
    .catch(() => {
      globalState.addLog('warn', '⚠️ #forward-button:not([disabled]) não encontrado — tentando fallbacks...', cycle);
    });

  if (!isSpeedMode()) {
    if (Math.random() < 0.30) {
      await p.mouse.wheel(0, randInt(20, 60));
      await humanPause(randInt(200, 500));
      await p.mouse.wheel(0, -randInt(20, 60));
      await humanPause(randInt(100, 300));
    }
    await cogPause(400, 1400);
  }

  // Lista de seletores tentados em ordem de prioridade
  const FORWARD_SELS = [
    '#forward-button',
    '[data-testid="forward-button"]',
    '[data-testid="submit-button"]',
    'button[type="submit"]',
    'button:has-text("Continuar")',
    'button:has-text("Continue")',
    'button:has-text("Próximo")',
    'button:has-text("Next")',
    'button:has-text("Avançar")',
    '[data-testid="step-bottom-navigation"] button',
  ];

  for (const sel of FORWARD_SELS) {
    try {
      const el = p.locator(sel).first();
      const visible = await el.isVisible({ timeout: 1500 }).catch(() => false);
      if (!visible) continue;

      const box = await el.boundingBox().catch(() => null);
      if (box) {
        await humanMouseMove(p, box.x + box.width * randFloat(0.22, 0.78), box.y + box.height * randFloat(0.22, 0.78));
        await humanPause(randInt(sp(80), sp(200)));
      }
      await el.click({ force: true, timeout: 5000 });
      globalState.addLog('info', `🖱️ Botão avançar clicado (${sel})`, cycle);
      return;
    } catch { /* tenta próximo */ }
  }

  globalState.addLog('warn', '⚠️ Nenhum botão de avançar encontrado — continuando sem clicar', cycle);
}

// ─── Scroll ───────────────────────────────────────────────────────────────────

export async function scrollIdle(p: Page): Promise<void> {
  if (isSpeedMode()) return;
  const segments = randInt(2, 3);
  let totalDown = 0;
  for (let i = 0; i < segments; i++) {
    const delta = randInt(30, 90);
    totalDown += delta;
    await p.mouse.wheel(0, delta);
    await humanPause(randInt(250, 600));
  }
  await humanPause(randInt(400, 900));
  await p.mouse.wheel(0, -totalDown);
  await humanPause(randInt(150, 400));
}

// ─── Aquecimento de página ────────────────────────────────────────────────────

export async function pageWarmup(p: Page, cycle: number): Promise<void> {
  if (isSpeedMode()) {
    await humanPause(randInt(300, 700));
    return;
  }

  globalState.addLog('info', '🔥 Aquecendo página (simulando leitura)...', cycle);

  const waypoints = [
    { x: randInt(60, 320), y: randInt(90, 230) },
    { x: randInt(40, 350), y: randInt(190, 380) },
    { x: randInt(90, 290), y: randInt(310, 520) },
  ];
  for (const pt of waypoints) {
    await humanMouseMove(p, pt.x, pt.y);
    await humanPause(randInt(180, 480));
  }

  await scrollIdle(p);

  try {
    const inputBox = await p.locator('#PHONE_NUMBER_or_EMAIL_ADDRESS').first().boundingBox().catch(() => null);
    if (inputBox) {
      await humanMouseMove(
        p,
        inputBox.x + inputBox.width * 0.5,
        inputBox.y + inputBox.height * 0.5
      );
      await humanPause(randInt(280, 620));

      const btnBox = await p.locator('#forward-button').first().boundingBox().catch(() => null);
      if (btnBox) {
        await humanMouseMove(
          p,
          btnBox.x + btnBox.width * randFloat(0.3, 0.7),
          btnBox.y + btnBox.height * randFloat(0.3, 0.7)
        );
        await humanPause(randInt(180, 460));
        await humanMouseMove(
          p,
          inputBox.x + inputBox.width * randFloat(0.4, 0.6),
          inputBox.y + inputBox.height * randFloat(0.4, 0.6)
        );
        await humanPause(randInt(250, 580));
      }
    }
  } catch { /* ignora */ }

  await cogPause(700, 1800);
  globalState.addLog('info', '✅ Aquecimento concluído', cycle);
}
