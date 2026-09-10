import axios from 'axios';

// Runs code against real test cases LOCALLY on this machine (Python/gcc/g++/
// JDK installed on the server host) — no dependency on the portal's compile
// service, whose request body turned out to be client-side encrypted.
export async function runTests(language, code, testcases) {
  const r = await axios.post('/api/execute/run-tests', { language, code, testcases });
  return r.data; // { ok, passedCount, totalCount, allPassed, results: [{index,label,passed,expected,actual,error?}], compileError? }
}
