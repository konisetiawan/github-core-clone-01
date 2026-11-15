import { createApp } from './app.ts';

async function main() {
  const rawEnvUrl = process.env.MAKEFUN_ENV_URL;
  if (!rawEnvUrl || rawEnvUrl.trim() === '') {
    process.stderr.write('MAKEFUN_ENV_URL environment variable is not set\n');
    process.exit(1);
  }
  const envUrl = rawEnvUrl.replace(/\/+$/, '');

  const server = createApp();
  await new Promise<void>((resolve, reject) => {
    server.listen(0, () => resolve());
    server.on('error', reject);
  });

  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : null;
  if (!port) {
    throw new Error('Failed to determine bound port');
  }

  console.log(`listening on port ${port}`);

  const registerUrl = `${envUrl}/register`;
  let regDelay = 250;
  const maxDelay = 2000;

  while (true) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 30000);
      const res = await fetch(registerUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ port }),
        signal: controller.signal,
      });
      clearTimeout(timeout);

      if (res.status === 200 || res.status === 409) {
        console.log('registered');
        break;
      }
      if (res.status === 400 || res.status === 405) {
        throw new Error(`Fatal registration error: status ${res.status}`);
      }
    } catch (err: any) {
      if (err.message && err.message.startsWith('Fatal registration error')) {
        throw err;
      }
    }
    await new Promise(r => setTimeout(r, regDelay));
    regDelay = Math.min(regDelay * 2, maxDelay);
  }

  const doneUrl = `${envUrl}/done`;
  let doneDelay = 250;

  while (true) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 30000);
      const res = await fetch(doneUrl, {
        method: 'GET',
        signal: controller.signal,
      });
      clearTimeout(timeout);

      if (res.status === 200) {
        const data = await res.json().catch(() => ({}));
        if (data && data.done === true) {
          console.log('done');
          break;
        }
      }
    } catch (err) {
      // retry on failure
    }
    await new Promise(r => setTimeout(r, doneDelay));
    doneDelay = Math.min(doneDelay * 2, maxDelay);
  }

  await new Promise<void>((resolve, reject) => {
    server.close((err) => {
      if (err) reject(err);
      else resolve();
    });
  });

  process.exit(0);
}

try {
  await main();
} catch (err: any) {
  process.stderr.write(`${err?.message || err}\n`);
  process.exit(1);
}
