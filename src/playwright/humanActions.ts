/**
 * humanActions.ts — Parte 1/2
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

// ─── Pausas ───────────────────────────────────────────────────────────────────

/**
 * Pausa com jitter gaussiano em torno do valor base.
 * Evita padrões periódicos detectados por análise estatística de timing.
 */
export async function humanPause(baseMs: number): Promise<void> {
  const effective = sp(baseMs);
  // Desvio padrão ~12% do valor base, truncado em ±25%
  const stddev = effective * 0.12;
  const jitter = clamp(Math.round(gaussianRand() * stddev), -effective * 0.25, effective * 0.25);
  const delay = Math.max(20, effective + jitter);
  await new Promise<void>((r) => setTimeout(r, delay));
}

/**
 * Pausa cognitiva — imita latência de decisão humana.
 * 20% chance de "distração" (pausa 2-4× mais longa).
 * Usa distribuição skewed para simular tempo de reação real.
 */
export async function cogPause(minMs: number, maxMs: number): Promise<void> {
  const base = randInt(sp(minMs), sp(maxMs));
  // Skew para direita: humanos têm cauda longa de pausas longas
  const skewed = base + Math.max(0, Math.round(gaussianRand() * base * 0.08));
  // "Distração": usuário olhou o celular, checou outra aba etc.
  const distracted = !isSpeedMode() && Math.random() < 0.20
    ? randInt(800, 3200)
    : 0;
  await new Promise<void>((r) => setTimeout(r, Math.max(30, skewed + distracted)));
}

/**
 * Micro-pausa — entre eventos de baixa latência (ex.: entre dígitos do OTP).
 * Mais curta que humanPause, mas ainda variável.
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
  // Ponto de partida aleatório (simula posição anterior do cursor)
  const startX = randInt(20, 380);
  const startY = randInt(60, 520);

  // Overshoot sutil: o mouse "passa" levemente do destino antes de pousar
  const overshootX = x + randInt(-8, 8);
  const overshootY = y + randInt(-6, 6);

  // Pontos de controle Bézier cúbica — variação orgânica
  const cp1X = startX + (overshootX - startX) * randFloat(0.15, 0.38) + randInt(-40, 40);
  const cp1Y = startY + (overshootY - startY) * randFloat(0.15, 0.38) + randInt(-25, 25);
  const cp2X = startX + (overshootX - startX) * randFloat(0.62, 0.85) + randInt(-25, 25);
  const cp2Y = startY + (overshootY - startY) * randFloat(0.62, 0.85) + randInt(-18, 18);

  const totalSteps = fast ? randInt(5, 9) : randInt(12, 24);

  for (let i = 0; i <= totalSteps; i++) {
    const rawT = i / totalSteps;
    // Ease-in-out cúbica: lento no início e fim
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

    // Velocidade sinusoidal: mais rápido no meio da trajetória
    const speedFactor = Math.sin(Math.PI * rawT);
    const stepDelay = fast
      ? Math.max(2, Math.round(4 * (1 - speedFactor * 0.65)))
      : Math.max(3, Math.round(randInt(7, 20) * (1 - speedFactor * 0.55)));
    await new Promise<void>((r) => setTimeout(r, stepDelay));
  }

  // Correção final: vai do overshoot para o alvo real
  if (!fast && (Math.abs(overshootX - x) > 2 || Math.abs(overshootY - y) > 2)) {
    await p.mouse.move(x + randInt(-1, 1), y + randInt(-1, 1));
    await new Promise<void>((r) => setTimeout(r, randInt(15, 40)));
    await p.mouse.move(x, y);
  }

  // Micro-tremor pós-chegada: mão humana não para instantaneamente
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

/**
 * Hover realista: move o cursor para um ponto aleatório dentro do elemento
 * (não necessariamente o centro), para depois de micro-jitter.
 */
export async function hoverElement(p: Page, selector: string): Promise<void> {
  try {
    const box = await p.locator(selector).first().boundingBox().catch(() => null);
    if (!box) return;
    // Ponto de hover: aleatório dentro dos 25-75% da área (evita bordas)
    const hx = Math.round(box.x + box.width  * randFloat(0.25, 0.75));
    const hy = Math.round(box.y + box.height * randFloat(0.28, 0.72));
    await humanMouseMove(p, hx, hy);
    // Dwell: usuário "lê" o elemento antes de clicar
    await humanPause(randInt(sp(140), sp(320)));
  } catch { /* ignora */ }
}

// ─── Digitação ────────────────────────────────────────────────────────────────

/**
 * WPM variável por sessão — simula usuários diferentes com ritmos distintos.
 * Retorna delay médio por caractere em ms.
 */
function sessionWpm(): number {
  // Persiste o WPM da sessão atual (evita que cada char tenha WPM diferente)
  if (!(globalThis as any).__humanWpm) {
    (globalThis as any).__humanWpm = randInt(40, 90);
  }
  return (globalThis as any).__humanWpm;
}

function wpmToCharDelay(): number {
  const wpm = sessionWpm();
  // 1 WPM ≈ 5 chars/min → chars/seg → ms/char
  const msPerChar = 60_000 / (wpm * 5);
  return Math.round(msPerChar);
}

/**
 * Digita texto de forma humana:
 * - WPM variável por sessão (40-90)
 * - Rafaga de caracteres rápidos + pausa burst (como digitadores reais)
 * - 4% chance de typo + backspace
 * - Pausa extra após espaço, @, ., ponto-e-vírgula
 * - Pausa ocasional simulando hesitação
 */
export async function humanType(p: Page, selector: string, value: string): Promise<void> {
  await p.waitForSelector(selector, { state: 'visible', timeout: 15000 });
  await hoverElement(p, selector);
  await p.click(selector);
  await p.fill(selector, '');
  await humanPause(randInt(sp(50), sp(130)));

  const fast = isSpeedMode();
  const baseCharDelay = fast ? randInt(12, 35) : wpmToCharDelay();

  // Tamanho do burst (número de chars digitados rapidamente antes de uma micro-pausa)
  let burstRemaining = randInt(3, 8);

  for (let i = 0; i < value.length; i++) {
    const ch = value[i]!;

    // Typo + backspace (modo normal)
    if (!fast && Math.random() < 0.04 && /[a-zA-Z]/.test(ch)) {
      const offset = Math.random() > 0.5 ? 1 : -1;
      const typoCode = ch.charCodeAt(0) + offset;
      if (typoCode > 64 && typoCode < 123) {
        const typo = String.fromCharCode(typoCode);
        await p.keyboard.type(typo, { delay: randInt(30, 70) });
        await humanPause(randInt(40, 100));
        await p.keyboard.press('Backspace');
        await humanPause(randInt(30, 80));
      }
    }

    // Delay por char: gaussiano em torno do baseCharDelay
    const charJitter = fast ? 0 : Math.round(gaussianRand() * baseCharDelay * 0.3);
    const charDelay = Math.max(8, baseCharDelay + charJitter);
    await p.keyboard.type(ch, { delay: charDelay });

    if (!fast) {
      // Pausa extra após delimitadores (simula reflexão ortográfica)
      if (' @._-/'.includes(ch)) {
        await humanPause(randInt(60, 180));
      }

      // Fim de burst: micro-pausa antes do próximo trecho
      burstRemaining--;
      if (burstRemaining <= 0) {
        await microPause();
        burstRemaining = randInt(3, 9);
      }

      // Hesitação ocasional (6%): usuário pensa na próxima parte
      if (Math.random() < 0.06) {
        await humanPause(randInt(100, 380));
      }
    }
  }
}

/**
 * Variante de humanType que limpa o campo forçosamente antes de digitar.
 * Útil para campos que ignoram fill() (ex.: React controlled inputs).
 */
export async function humanTypeForce(p: Page, selector: string, value: string): Promise<void> {
  await p.waitForSelector(selector, { state: 'visible', timeout: 15000 });
  await hoverElement(p, selector);
  await p.click(selector, { force: true });
  await humanPause(randInt(sp(70), sp(140)));

  // Limpar campo: Ctrl+A → Delete → confirma backspace
  await p.keyboard.press('ControlOrMeta+a');
  await humanPause(randInt(25, 55));
  await p.keyboard.press('Delete');
  await humanPause(randInt(sp(50), sp(130)));

  const currentVal = await p.locator(selector).inputValue().catch(() => '');
  if (currentVal.length > 0) {
    await p.click(selector, { clickCount: 3 });
    await humanPause(randInt(25, 55));
    for (let i = 0; i < currentVal.length; i++) {
      await p.keyboard.press('Backspace');
      if (i % 3 === 2) await microPause();
    }
    await humanPause(randInt(25, 55));
  }

  // Agora digita com o método normal
  const fast = isSpeedMode();
  const baseCharDelay = fast ? randInt(12, 35) : wpmToCharDelay();
  let burstRemaining = randInt(3, 8);

  for (let i = 0; i < value.length; i++) {
    const ch = value[i]!;

    if (!fast && Math.random() < 0.04 && /[a-zA-Z]/.test(ch)) {
      const offset = Math.random() > 0.5 ? 1 : -1;
      const typoCode = ch.charCodeAt(0) + offset;
      if (typoCode > 64 && typoCode < 123) {
        const typo = String.fromCharCode(typoCode);
        await p.keyboard.type(typo, { delay: randInt(30, 70) });
        await humanPause(randInt(40, 100));
        await p.keyboard.press('Backspace');
        await humanPause(randInt(30, 80));
      }
    }

    const charJitter = fast ? 0 : Math.round(gaussianRand() * baseCharDelay * 0.3);
    const charDelay = Math.max(8, baseCharDelay + charJitter);
    await p.keyboard.type(ch, { delay: charDelay });

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

  const finalVal = await p.locator(selector).inputValue().catch(() => '??');
  // Log de debug para verificação
  const { globalState: _gs } = await import('../state/globalState');
  _gs.addLog('info', `🔍 [DEBUG] Campo "${selector}" → "${finalVal}"`);
}

// ─── Click ────────────────────────────────────────────────────────────────────

/**
 * Click humano: hover → dwell variável → mouse.down → hold → mouse.up.
 * Arkose mede exatamente a duração do press (40-130ms é o range humano real).
 */
export async function humanClick(p: Page, selector: string): Promise<void> {
  await p.waitForSelector(selector, { state: 'visible', timeout: 15000 });
  const box = await p.locator(selector).first().boundingBox();
  if (box) {
    const tx = Math.round(box.x + box.width  * randFloat(0.22, 0.78));
    const ty = Math.round(box.y + box.height * randFloat(0.22, 0.78));
    await humanMouseMove(p, tx, ty);
    // Dwell pré-clique crítico: usuário avalia o botão antes de apertar
    await humanPause(randInt(sp(100), sp(300)));
    await p.mouse.down();
    // Duração do hold: 40-130ms — toque humano real é 60-100ms em média
    const holdMs = isSpeedMode() ? randInt(30, 80) : randInt(45, 130);
    await new Promise<void>((r) => setTimeout(r, holdMs));
    await p.mouse.up();
    // Pequena pausa pós-release (finger lift simulation)
    await humanPause(randInt(sp(30), sp(80)));
  } else {
    await p.click(selector);
  }
}

// ─── Forward button ───────────────────────────────────────────────────────────

/**
 * Aguarda o #forward-button ficar habilitado e faz o click com pausa pensativa.
 * Simula o usuário revisando o que digitou antes de continuar.
 */
export async function clickForwardButton(p: Page, cycle: number): Promise<void> {
  const { globalState: _gs } = await import('../state/globalState');
  _gs.addLog('info', '⏳ Aguardando #forward-button habilitado...', cycle);

  await p.waitForSelector('#forward-button:not([disabled])', { state: 'visible', timeout: 15000 })
    .catch(async () => {
      _gs.addLog('warn', '⚠️ #forward-button:not([disabled]) não encontrado, tentando mesmo assim...', cycle);
    });

  // Pausa pensativa: usuário rola o olho pelo formulário antes de avançar
  if (!isSpeedMode()) {
    // Scroll leve de revisão (30% chance)
    if (Math.random() < 0.30) {
      await p.mouse.wheel(0, randInt(20, 60));
      await humanPause(randInt(200, 500));
      await p.mouse.wheel(0, -randInt(20, 60));
      await humanPause(randInt(100, 300));
    }
    await cogPause(400, 1400);
  }

  await humanClick(p, '#forward-button');
  _gs.addLog('info', '🖱️ #forward-button clicado', cycle);
}

// ─── Scroll ───────────────────────────────────────────────────────────────────

/**
 * Scroll de leitura: desce em segmentos não-uniformes (imita leitura),
 * faz uma pausa como se o usuário lesse um parágrafo, depois volta.
 */
export async function scrollIdle(p: Page): Promise<void> {
  if (isSpeedMode()) return;
  // Desce em 2-3 etapas para simular leitura de parágrafo
  const segments = randInt(2, 3);
  let totalDown = 0;
  for (let i = 0; i < segments; i++) {
    const delta = randInt(30, 90);
    totalDown += delta;
    await p.mouse.wheel(0, delta);
    await humanPause(randInt(250, 600));
  }
  // Pausa de leitura antes de voltar
  await humanPause(randInt(400, 900));
  // Volta de uma vez (rolar de volta é geralmente mais rápido)
  await p.mouse.wheel(0, -totalDown);
  await humanPause(randInt(150, 400));
}

// ─── Aquecimento de página ────────────────────────────────────────────────────

/**
 * pageWarmup: constrói histórico de interação ANTES de preencher o formulário.
 * O Arkose analisa o padrão de movimentos ANTES do submit.
 * Sequência: hover no campo → hesitar no botão → voltar ao campo → ler
 */
export async function pageWarmup(p: Page, cycle: number): Promise<void> {
  const { globalState: _gs } = await import('../state/globalState');
  if (isSpeedMode()) {
    await humanPause(randInt(300, 700));
    return;
  }

  _gs.addLog('info', '🔥 Aquecendo página (simulando leitura)...', cycle);

  // 1. Movimentos aleatórios simulando olhar para o formulário
  const waypoints = [
    { x: randInt(60, 320), y: randInt(90, 230) },
    { x: randInt(40, 350), y: randInt(190, 380) },
    { x: randInt(90, 290), y: randInt(310, 520) },
  ];
  for (const pt of waypoints) {
    await humanMouseMove(p, pt.x, pt.y);
    await humanPause(randInt(180, 480));
  }

  // 2. Scroll de leitura
  await scrollIdle(p);

  // 3. Hover no campo de email → hesitar no botão → voltar
  //    Esse padrão "olhar o botão antes de digitar" é muito humano
  try {
    const inputBox = await p.locator('#PHONE_NUMBER_or_EMAIL_ADDRESS').first().boundingBox().catch(() => null);
    if (inputBox) {
      // Olha para o campo
      await humanMouseMove(
        p,
        inputBox.x + inputBox.width * 0.5,
        inputBox.y + inputBox.height * 0.5
      );
      await humanPause(randInt(280, 620));

      // Olha para o botão (hesitação)
      const btnBox = await p.locator('#forward-button').first().boundingBox().catch(() => null);
      if (btnBox) {
        await humanMouseMove(
          p,
          btnBox.x + btnBox.width * randFloat(0.3, 0.7),
          btnBox.y + btnBox.height * randFloat(0.3, 0.7)
        );
        await humanPause(randInt(180, 460));

        // Volta para o campo (padrão de hesitação real)
        await humanMouseMove(
          p,
          inputBox.x + inputBox.width * randFloat(0.4, 0.6),
          inputBox.y + inputBox.height * randFloat(0.4, 0.6)
        );
        await humanPause(randInt(250, 580));
      }
    }
  } catch { /* ignora */ }

  // 4. Pausa final "usuário decide começar a preencher"
  await cogPause(700, 1800);
  _gs.addLog('info', '✅ Aquecimento concluído', cycle);
}
