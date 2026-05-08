import fs from 'fs';
import path from 'path';
import { globalState } from '../state/globalState';

export class ArtifactsManager {
  static screenshotsDir = path.join(process.cwd(), 'artifacts/screenshots');
  static htmlDir = path.join(process.cwd(), 'artifacts/html');

  static init() {
    [this.screenshotsDir, this.htmlDir].forEach(dir => {
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
    });
  }

  static async saveScreenshot(page: any, cycle: number, step: string, error?: string): Promise<string> {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `cycle-${cycle}-${step}-${timestamp}.png`;
    const filepath = path.join(this.screenshotsDir, filename);
    
    try {
      await page.screenshot({ path: filepath, fullPage: true });
      globalState.addLog('warn', `📸 Screenshot salvo: ${filename}`, cycle);
      return filename;
    } catch (e) {
      globalState.addLog('error', `❌ Falha ao salvar screenshot: ${e}`, cycle);
      return '';
    }
  }

  static saveHTML(page: any, cycle: number, step: string): Promise<string> {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `cycle-${cycle}-${step}-${timestamp}.html`;
    const filepath = path.join(this.htmlDir, filename);
    
    return page.content().then(html => {
      fs.writeFileSync(filepath, html);
      globalState.addLog('warn', `🌐 HTML salvo: ${filename}`, cycle);
      return filename;
    }).catch(e => {
      globalState.addLog('error', `❌ Falha ao salvar HTML: ${e}`, cycle);
      return '';
    });
  }
}