import { globalState } from '../state/globalState';

// Tipo compatível com page.screenshot() do Playwright
type PageLike = {
  screenshot: (o: { path: string; fullPage: boolean }) => Promise<Buffer | void>;
  content: () => Promise<string>;
};

/**
 * ArtifactsManager — salvamento em disco DESATIVADO.
 * Screenshots e HTMLs de erro consumiam +1GB em ciclos com falha.
 * Os logs de erro continuam disponíveis via globalState (API /api/logs).
 */
export class ArtifactsManager {
  static screenshotsDir = '';
  static htmlDir = '';

  static init(): void {
    // desativado — não cria pastas em disco
  }

  static async saveScreenshot(
    _page: PageLike,
    cycle: number,
    step: string
  ): Promise<string> {
    globalState.addLog('warn', `📸 Screenshot de erro ignorado (salvamento em disco desativado) — step: ${step}`, cycle);
    return '';
  }

  static async saveHTML(
    _page: PageLike,
    cycle: number,
    step: string
  ): Promise<string> {
    globalState.addLog('warn', `🌐 HTML de erro ignorado (salvamento em disco desativado) — step: ${step}`, cycle);
    return '';
  }

  static async saveErrorArtifacts(_page: PageLike, cycle: number): Promise<void> {
    globalState.addLog('warn', `🗑️ Artifacts de erro do ciclo #${cycle} descartados (disco desativado)`, cycle);
  }
}
