// Live smoke test: boots the modified backend/server.js, fires a real Phase 1
// request (ep16 audio + Stage 1 captions), checks the response shape.
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '../..');
const RESULTS_DIR = path.join(__dirname, 'results');

async function main() {
  const stage1 = JSON.parse(fs.readFileSync(path.join(RESULTS_DIR, 'ep16_stage1.json'), 'utf8'));
  const audioPath = process.env.TEST_AUDIO || 'C:/Users/Lawre/OneDrive/Documents/abc-captions/Test files/ep16/ep16_audio.mp3';

  const server = spawn(process.execPath, [path.join(ROOT, 'backend', 'server.js')], {
    env: { ...process.env, SHARED_SECRET: 'smoke-test', PORT: '3199' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout.on('data', d => process.stdout.write('[server] ' + d));
  server.stderr.on('data', d => process.stdout.write('[server:err] ' + d));

  try {
    // wait for listen
    await new Promise((res, rej) => {
      const t = setTimeout(() => rej(new Error('server did not start')), 10000);
      server.stdout.on('data', d => { if (String(d).includes('Proxy running')) { clearTimeout(t); res(); } });
    });

    const form = new FormData();
    form.append('audio', new Blob([fs.readFileSync(audioPath)], { type: 'audio/mpeg' }), 'ep16_audio.mp3');
    form.append('captions', JSON.stringify(stage1.captions));

    console.log('POSTing Phase 1 request...');
    const t0 = Date.now();
    const resp = await fetch('http://localhost:3199/api/refine', {
      method: 'POST',
      headers: { 'X-Secret': 'smoke-test' },
      body: form,
    });
    const raw = (await resp.text()).trim();
    const data = JSON.parse(raw);
    console.log(`\nHTTP ${resp.status} in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    console.log('status:', data.status);
    console.log('suggestions:', Array.isArray(data.suggestions) ? data.suggestions.length : 'MISSING');
    if (Array.isArray(data.suggestions)) {
      const selfLinks = data.suggestions.filter(s => Array.isArray(s.linked_suggestions) && s.linked_suggestions.includes(s.caption_index)).length;
      console.log('self-links remaining (should be 0):', selfLinks);
      fs.writeFileSync(path.join(RESULTS_DIR, 'smoke_server_response.json'), JSON.stringify(data, null, 2));
    }
    if (data.status !== 'suggestions') { console.error('FAIL'); process.exitCode = 1; }
    else console.log('SMOKE TEST PASS');
  } finally {
    server.kill();
  }
}

main().catch(e => { console.error(e); process.exit(1); });
