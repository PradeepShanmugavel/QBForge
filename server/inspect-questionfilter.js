// Inspect the /api/v2/questionfilter response so we can parse it correctly.
// Usage: put your token in token.txt (same folder), then:  node inspect-questionfilter.js
const fs = require('fs');
const path = require('path');

function readToken() {
  if (process.argv[2]) return process.argv[2].trim();
  try { return fs.readFileSync(path.join(__dirname, 'token.txt'), 'utf8').trim(); } catch (e) { return ''; }
}
const TOKEN = readToken();
const BASE = 'https://api.examly.io';
const QB_ID = process.argv[3] || '01169e75-2c44-483d-bbbc-75acacf1d80a'; // array bank, 22 Qs, confirmed in UI

if (!TOKEN) { console.error('No token. Put your eyJ... token in token.txt'); process.exit(1); }

async function post(body, tries) {
  tries = tries || 3;
  try {
    const r = await fetch(BASE + '/api/v2/questionfilter', {
      method: 'POST',
      headers: { Authorization: TOKEN, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(body)
    });
    const text = await r.text();
    return { status: r.status, text: text };
  } catch (e) {
    if (tries > 1) { await new Promise(r => setTimeout(r, 700)); return post(body, tries - 1); }
    return { status: 'ERR', text: e.message };
  }
}

(async function () {
  const types = ['Single', 'Multiple', 'Programming', 'Descriptive', 'Fillups', 'Coding', 'code', 'mcq', 'MCQ'];
  for (const t of types) {
    const res = await post({ qb_id: QB_ID, type: t, page: 1, limit: 50 });
    let shape = res.text;
    try {
      const j = JSON.parse(res.text);
      const keys = Object.keys(j);
      let count = '';
      if (j.results) {
        if (Array.isArray(j.results)) count = 'results=array(' + j.results.length + ')';
        else count = 'results keys={' + Object.keys(j.results).join(',') + '}' +
          (j.results.count != null ? ' count=' + j.results.count : '') +
          (Array.isArray(j.results.questions) ? ' questions=' + j.results.questions.length : '');
      }
      shape = 'top keys={' + keys.join(',') + '} ' + count;
    } catch (e) {}
    console.log('type=' + t.padEnd(12), 'status=' + res.status, '|', shape.slice(0, 300));
  }
  // Also dump ONE full response so we can see a sample question object
  const full = await post({ qb_id: QB_ID, type: 'Single', page: 1, limit: 2 });
  console.log('\n--- FULL RESPONSE (type=Single, limit=2) ---\n' + full.text.slice(0, 2500));
})();