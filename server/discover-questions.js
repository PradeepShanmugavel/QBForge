// Discover the "fetch questions in a QB" endpoint.
// Usage:  node discover-questions.js <FRESH_JWT_TOKEN> [qb_id]
// Token = the same JWT you paste into Step 1 (raw eyJ... value).

const fs = require('fs');
const path = require('path');

// Token can come from: command-line arg, OR a file named token.txt next to this script.
function readToken() {
  if (process.argv[2]) return process.argv[2].trim();
  if (process.env.EXAMLY_TOKEN) return process.env.EXAMLY_TOKEN.trim();
  try {
    var p = path.join(__dirname, 'token.txt');
    if (fs.existsSync(p)) return fs.readFileSync(p, 'utf8').trim();
  } catch (e) {}
  return '';
}

const TOKEN = readToken();
const QB_ID = process.argv[3] || '01169e75-2c44-483d-bbbc-75acacf1d80a'; // NeoColab_Java_MCQ_array (22 Qs)
const BASE  = 'https://api.examly.io';

const DEPARTMENT_IDS = [
  "df128e4a-e75e-426e-9d59-bff816f08a72","988be022-e14d-4662-99c0-8bef716fc826",
  "a6d5352b-4eba-4eab-9d42-53be25022198","09abbbe9-f2f3-4503-aa43-f0785059b0d2",
  "6610561a-f5b2-433c-8dcd-5902a1f71dc8","efa47177-57a4-4b22-9414-d4982a59a3a1",
  "b436748f-f22a-41bb-a760-ae12d76b74a4","59283fa5-e3c5-43d9-9249-c608ce678da0",
  "a2be84c8-7478-465e-b6d0-ce866779fc91","bf7c065e-8d55-4bed-8acb-af1a95921c57",
  "65dea691-1760-44b9-8fa5-d2250d42493b","dd364bb3-7c10-4241-9557-80e002b0001a",
  "19f0d0ea-714e-4de4-b1e8-527e79620893","531a1b18-362d-4868-a3c7-8d40358afed9",
  "e999c4b1-bfe3-4369-b2bf-5ef3458efe94","c5dd9953-15fd-45bb-bec8-f252bf2a89d2",
  "01b622fd-a74c-49f0-ae35-66bfb6eef5ab","69605d3b-2b06-4da6-8836-ab59ce6844f3",
  "b1909585-e394-414e-b5bd-25101ab81c84","955329cb-2d14-4ca4-b665-b1a2a0d5d000",
  "02aaaf75-d6ed-422e-a3e3-bf1889c1b9ae","3151c244-771f-41db-9443-486bde24442c",
  "a6e2f79e-4ff9-4511-a5b8-af62afb2c02e","3ae4ebd3-70bb-4a55-8a42-f7e655fe2e2f",
  "7ac25507-e0b0-473b-a06f-d6093f1f2e41","c1606ab4-a275-4108-b603-208742aeda77",
  "28ab722d-201b-4ae8-a2a6-fe690b13572f","45ac9dcd-9586-4f0a-a48a-6d23f6a7792a",
  "c799f089-a321-47e5-8c24-dcf3dbda2e31","6ab5f6f2-d474-4d75-b3f2-2cde376b9227",
  "c80b12a2-cccb-4040-86e3-9801ab28d422","132c6552-4768-42db-b46f-db52a5ea0cf4",
  "2d85cfc2-5760-4588-b581-50d4f88b17bd","a0dbfb8e-fdf4-4181-a03e-a63e743b6844",
  "b7372175-e687-4dd0-a3fb-09dfbb962a3e"
];

if (!TOKEN) {
  console.error('\nERROR: No token found.\n' +
    'Easiest fix: create a file called  token.txt  in this same folder,\n' +
    'paste your eyJ... token into it, save, then run:  node discover-questions.js\n');
  process.exit(1);
}

// Common payload shapes Examly endpoints accept.
const fullBody = {
  branch_id: 'all',
  department_id: DEPARTMENT_IDS,
  mainDepartmentUser: true,
  qb_id: QB_ID,
  questionbank_id: QB_ID,
  question_bank_id: QB_ID,
  page: 1,
  limit: 25,
  visibility: 'All'
};

// Candidate endpoints: [method, path, body|null]
var byTag = Object.assign({}, fullBody, { tag_id: 1026867, tags: ["NeoColab_Java_MCQ_array"], tag_ids: [1026867] });
const candidates = [
  ['POST', '/api/v2/questions', fullBody],
  ['POST', '/api/v2/questions/list', fullBody],
  ['POST', '/api/v2/question', fullBody],
  ['POST', '/api/v2/question/list', fullBody],
  ['POST', '/api/v2/getQuestions', fullBody],
  ['POST', '/api/v2/questions/getall', fullBody],
  ['POST', '/api/v2/questions/getAll', fullBody],
  ['POST', '/api/v2/question/getall', fullBody],
  ['POST', '/api/v2/questions/fetch', fullBody],
  ['POST', '/api/v2/questionbank/questions', fullBody],
  ['POST', '/api/v2/questionbanks/questions', fullBody],
  ['POST', '/api/v2/questionbankquestions', fullBody],
  ['POST', '/api/v2/questionbank/getQuestions', fullBody],
  ['POST', '/api/v2/questionbank/getallquestions', fullBody],
  ['POST', '/api/v2/questionbank/getQuestionByQb', fullBody],
  ['POST', '/api/v2/getquestionbankquestions', fullBody],
  ['POST', '/api/v2/getQuestionBankById', fullBody],
  ['POST', '/api/v2/questionbank', fullBody],
  ['POST', '/api/v2/qb/questions', fullBody],
  ['POST', '/api/v2/preview/questionbank', fullBody],
  ['POST', '/api/v2/questionbankpreview', fullBody],
  ['POST', '/api/v2/questions/getQuestionsByQb', fullBody],
  ['POST', '/api/v2/getQuestionByQuestionBank', fullBody],
  // tag-based variants (this bank has tag_id 1026867)
  ['POST', '/api/v2/questions', byTag],
  ['POST', '/api/v2/questions/byTag', byTag],
  ['POST', '/api/v2/questions/getByTag', byTag],
  // non-v2 namespace (notifications used /api/school/..., so questions may be /api/...)
  ['POST', '/api/questionbank/questions', fullBody],
  ['POST', '/api/questionbank/getQuestions', fullBody],
  ['POST', '/api/questions', fullBody],
  ['POST', '/api/v1/questions', fullBody],
  // GET variants
  ['GET',  '/api/v2/questionbank/' + QB_ID, null],
  ['GET',  '/api/v2/questionbanks/' + QB_ID, null],
  ['GET',  '/api/v2/questionbank/' + QB_ID + '/questions', null],
  ['GET',  '/api/v2/questionbanks/' + QB_ID + '/questions', null],
  ['GET',  '/api/v2/qb/' + QB_ID + '/questions', null],
  ['GET',  '/api/v2/questions?qb_id=' + QB_ID, null],
  ['GET',  '/api/v2/questions?questionbank_id=' + QB_ID, null],
  ['GET',  '/api/v2/questionbankquestions?qb_id=' + QB_ID, null],
  ['GET',  '/api/v2/question?qb_id=' + QB_ID, null]
];

function topKeys(obj, depth) {
  if (obj == null || typeof obj !== 'object') return JSON.stringify(obj);
  if (Array.isArray(obj)) return '[array len=' + obj.length + (obj.length ? ', first keys: ' + topKeys(obj[0], 0) : '') + ']';
  var keys = Object.keys(obj).slice(0, 12);
  return '{' + keys.join(', ') + '}';
}

async function tryOne(method, path, body) {
  var url = BASE + path;
  var opts = {
    method: method,
    headers: { 'Authorization': TOKEN, 'Content-Type': 'application/json', 'Accept': 'application/json' }
  };
  if (body && method !== 'GET') opts.body = JSON.stringify(body);
  try {
    var r = await fetch(url, opts);
    var text = await r.text();
    var data = null;
    try { data = JSON.parse(text); } catch (e) {}
    var mark = (r.status >= 200 && r.status < 300) ? ' <<<<< SUCCESS' : '';
    console.log(method.padEnd(4), r.status, path, mark);
    if (r.status >= 200 && r.status < 300 && data) {
      console.log('      response shape:', topKeys(data, 0));
      if (data.results) console.log('      results:', topKeys(data.results, 0));
    } else if (data && data.message) {
      console.log('      msg:', data.message);
    }
  } catch (e) {
    console.log(method.padEnd(4), 'ERR ', path, '-', e.message);
  }
}

(async function () {
  console.log('\nProbing question-fetch endpoints for qb_id=' + QB_ID + '\n');
  for (var i = 0; i < candidates.length; i++) {
    await tryOne(candidates[i][0], candidates[i][1], candidates[i][2]);
  }
  console.log('\nDone. Copy the line(s) marked SUCCESS and its response shape back to chat.\n');
})();