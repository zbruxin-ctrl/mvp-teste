import { chromium as chromiumExtra } from 'playwright-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import { Browser, Page, BrowserContext, devices } from 'playwright';
import type { Cookie } from 'playwright';
import { globalState } from '../state/globalState';
import { createEmailClient } from '../tempMail/client';
import { IEmailClient } from '../types/tempMail';
import { EmailProvider } from '../types';
import { gerarPayloadCompleto } from '../utils/dataGenerators';
import { ArtifactsManager } from '../utils/artifacts';
import * as accountStore from '../store/accountStore';
import {
  isSpeedMode, sp, randInt, randFloat,
  humanPause, cogPause,
  humanMouseMove, hoverElement, focusField, _typeChar,
  humanType, humanTypeForce, humanClick,
  clickForwardButton, scrollIdle, pageWarmup,
} from './humanActions';

chromiumExtra.use(StealthPlugin());

let browser: Browser | null = null;
let browserLaunching = false;
let currentLaunchProxy: string | null = null;

const contextosPorCiclo = new Map<number, import('playwright').BrowserContext>();

const CYCLE_TIMEOUT_MS = 10 * 60 * 1_000;
const MOBILE_DEVICE = {
  ...devices['iPhone 14'],
  viewport: { width: 390, height: 844 },
  screen:   { width: 390, height: 844 },
};

// ─── Formato Tampermonkey ─────────────────────────────────────────────────────

function cookiesToTampermonkey(cookies: Cookie[]): [string, string, string, number, number, number][] {
  return cookies.map((c) => [
    c.name,
    c.value,
    c.domain,
    c.secure ? 1 : 0,
    c.httpOnly ? 1 : 0,
    c.expires > 0 ? Math.round(c.expires * 1000) : -1,
  ]);
}

function gerarTampermonkeyScript(cookies: Cookie[], email: string): string {
  const cookieArr = cookiesToTampermonkey(cookies);
  const cookieJson = JSON.stringify(cookieArr);
  const header = [
    '// ==UserScript==',
    '// @name         Uber Cookie Injector — ' + email,
    '// @namespace    http://tampermonkey.net/',
    '// @version      1.0',
    '// @description  Injeta cookies de sessão Uber',
    '// @author       MVP',
    '// @match        https://*.uber.com/*',
    '// @grant        GM_cookie',
    '// @run-at       document-start',
    '// ==/UserScript==',
  ].join('\n');
  const body =
    '(function(){' +
    'var H=window.location.hostname,C=' + cookieJson + ';' +
    'var ok=function(d){d=d.replace(/^[.]/,"");return H===d||H.endsWith("."+d)};' +
    'var EX=Date.now()+3154e7;' +
    'C.forEach(function(c){' +
    'var n=c[0],v=c[1],d=c[2],s=c[3],h=c[4],e=c[5]>0?c[5]:EX;' +
    'if(typeof GM_cookie!="undefined")GM_cookie.set({name:n,value:v,domain:d.replace(/^[.]/,""),path:"/",secure:!!s,httpOnly:!!h,expirationDate:Math.floor(e/1000)},function(){});' +
    'if(!h&&ok(d)){var ck=n+"="+v+";path=/;expires="+new Date(e).toUTCString()+(s?";secure":"")+";";' +
    'try{document.cookie=ck;}catch(x){}}' +
    '});' +
    'var RAN="__scr_done";' +
    'if(!sessionStorage.getItem(RAN)){sessionStorage.setItem(RAN,"1");' +
    'setTimeout(function(){location.href="https://account.uber.com/security";},800);}' +
    '})()';
  return header + '\n' + body;
}

// ─── Detecção de URL ──────────────────────────────────────────────────────────

function isSuccessUrl(url: string): boolean {
  return (
    url.includes('rider.uber.com') ||
    (url.includes('m.uber.com') && !url.includes('auth.uber.com')) ||
    url.includes('uber.com/go') ||
    url.includes('uber.com/home') ||
    url.includes('uber.com/feed') ||
    url.includes('/account') ||
    url.includes('/profile') ||
    url.includes('/dashboard') ||
    url.includes('/home')
  );
}

function isOnboardingUrl(url: string): boolean {
  return (
    url.includes('auth.uber.com') ||
    url.includes('bonjour.uber.com') ||
    url.includes('/signup') ||
    url.includes('/register') ||
    url.includes('/onboard') ||
    url.includes('/verify') ||
    url.includes('/confirm')
  );
}

// ─── Logger ───────────────────────────────────