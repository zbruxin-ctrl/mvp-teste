const { MockPlaywrightFlow } = require('../dist/playwright/mockFlow');

const ciclos = parseInt(process.env.BOT_CICLOS || '1');
const provider = process.env.BOT_EMAIL_PROVIDER || 'tempmailc';
const inviteCode = process.env.BOT_INVITE_CODE || '';
const otpTimeout = parseInt(process.env.BOT_OTP_TIMEOUT || '120') * 1000;
const cadastroUrl = process.env.BOT_CADASTRO_URL || 'https://bonjour.uber.com/';
const apiKey = process.env.TEMP_MAIL_API_KEY || '';

(async () => {
  console.log(`Iniciando bot: ${ciclos} ciclo(s) | provider: ${provider}`);

  await MockPlaywrightFlow.init(true);

  const promises = [];
  for (let i = 1; i <= ciclos; i++) {
    promises.push(
      MockPlaywrightFlow.execute(cadastroUrl, {
        emailProvider: provider,
        tempMailApiKey: apiKey,
        otpTimeout,
        extraDelay: 0,
        inviteCode,
      }, i)
    );
  }

  await Promise.all(promises);
  await MockPlaywrightFlow.cleanup();

  console.log('Bot finalizado!');
})().catch((e) => {
  console.error('Erro fatal:', e);
  process.exit(1);
});
