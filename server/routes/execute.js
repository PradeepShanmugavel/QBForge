'use strict';
// Runs generated solution code against a question's real test cases LOCALLY
// on this machine — no dependency on the portal's compile service at all,
// which turned out to be a dead end (its request body is client-side
// encrypted with a key baked into the portal's frontend JS, not something we
// can safely reverse-engineer). Same verification result (pass/fail per test
// case), fully under our own control: no rate limits, no encryption, no
// external dependency once the toolchains below are installed.
const express = require('express');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const router = express.Router();

const RUN_TIMEOUT_MS = 5000;      // per test case — catches infinite loops in the candidate's logic
const COMPILE_TIMEOUT_MS = 20000; // compiling (esp. C++ headers like <bits/stdc++.h> or heavy STL includes,
                                   // cold-cache first run) legitimately takes longer than a run-time infinite
                                   // loop should ever be allowed — confirmed live: g++ alone hit the old 5s
                                   // run-timeout on a completely valid, non-hanging program.

// The already-running dev server process captured its PATH at launch, long
// before today's toolchain installs — a nodemon restart re-execs node but
// does NOT re-read the system/user PATH from the registry, so the installed
// tools would otherwise stay invisible until the whole terminal is restarted.
// Fixed by prepending their known install directories directly to the
// PATH used for every spawned child process here, independent of whatever
// the parent Node process's own (stale) PATH is.
var EXTRA_PATH_DIRS = [
  'C:\\Users\\PradeepS\\AppData\\Local\\Programs\\Python\\Python312',
  'C:\\Users\\PradeepS\\AppData\\Local\\Microsoft\\WinGet\\Packages\\BrechtSanders.WinLibs.POSIX.UCRT_Microsoft.Winget.Source_8wekyb3d8bbwe\\mingw64\\bin',
  'C:\\Users\\PradeepS\\jdk21\\jdk-21.0.12.1+1\\bin' // portable ZIP extract — MSI installs all needed admin elevation we can't grant non-interactively
];

function childEnv() {
  return Object.assign({}, process.env, { PATH: EXTRA_PATH_DIRS.join(';') + ';' + (process.env.PATH || '') });
}

function runProcess(cmd, args, input, cwd, timeoutMs) {
  timeoutMs = timeoutMs || RUN_TIMEOUT_MS;
  return new Promise(function(resolve) {
    var child;
    try {
      child = spawn(cmd, args, { cwd: cwd, windowsHide: true, env: childEnv() });
    } catch (e) {
      return resolve({ ok: false, error: 'Could not start ' + cmd + ': ' + e.message });
    }
    var stdout = '', stderr = '', done = false;
    var timer = setTimeout(function() {
      if (done) return;
      done = true;
      child.kill();
      resolve({ ok: false, error: 'Timed out after ' + timeoutMs + 'ms' });
    }, timeoutMs);

    child.stdout.on('data', function(d) { stdout += d; });
    child.stderr.on('data', function(d) { stderr += d; });
    child.on('error', function(e) {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ ok: false, error: e.message });
    });
    child.on('close', function(code) {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (code !== 0 && stderr) return resolve({ ok: false, error: stderr.trim() || ('exit code ' + code) });
      resolve({ ok: true, stdout: stdout, stderr: stderr });
    });

    if (input != null) child.stdin.write(input);
    child.stdin.end();
  });
}

// One compile step (if needed) + a run-per-testcase step, per language.
// Returns { compileError } if compilation failed, or null if compilation
// succeeded / wasn't needed.
function prepare(language, code, dir) {
  var lang = String(language || '').toLowerCase();

  if (lang.indexOf('python') !== -1) {
    var pyFile = path.join(dir, 'main.py');
    fs.writeFileSync(pyFile, code, 'utf8');
    return Promise.resolve({ run: function(input) { return runProcess('python', [pyFile], input, dir); } });
  }

  // Match "c", "c (17)", "c(17)", etc. but NOT "c++" — versioned variants
  // like "C (17)" (added for the portal's per-version language catalog)
  // wouldn't match a strict `lang === 'c'` check, and would otherwise fall
  // through all the way to "Unsupported language" for local execution even
  // though they're just C.
  if (lang.indexOf('c++') === -1 && lang.indexOf('cpp') === -1 && /^c(\s|\(|$)/.test(lang)) {
    var cFile = path.join(dir, 'main.c');
    var cExe = path.join(dir, 'main.exe');
    fs.writeFileSync(cFile, code, 'utf8');
    return runProcess('gcc', [cFile, '-o', cExe], null, dir, COMPILE_TIMEOUT_MS).then(function(r) {
      if (!r.ok) return { compileError: r.error };
      return { run: function(input) { return runProcess(cExe, [], input, dir); } };
    });
  }

  if (lang.indexOf('c++') !== -1 || lang === 'cpp') {
    var cppFile = path.join(dir, 'main.cpp');
    var cppExe = path.join(dir, 'main.exe');
    fs.writeFileSync(cppFile, code, 'utf8');
    return runProcess('g++', [cppFile, '-o', cppExe], null, dir, COMPILE_TIMEOUT_MS).then(function(r) {
      if (!r.ok) return { compileError: r.error };
      return { run: function(input) { return runProcess(cppExe, [], input, dir); } };
    });
  }

  if (lang.indexOf('java') !== -1) {
    // Our generated Java code always uses `public class Main` (matches the
    // established convention already used elsewhere in this app), so the
    // filename must be Main.java for javac to accept it.
    var javaFile = path.join(dir, 'Main.java');
    fs.writeFileSync(javaFile, code, 'utf8');
    return runProcess('javac', [javaFile], null, dir, COMPILE_TIMEOUT_MS).then(function(r) {
      if (!r.ok) return { compileError: r.error };
      return { run: function(input) { return runProcess('java', ['-cp', dir, 'Main'], input, dir); } };
    });
  }

  return Promise.resolve({ compileError: 'Unsupported language for local execution: ' + language });
}

// Judge-standard comparison: trim trailing whitespace on each line and
// trailing blank lines, but don't ignore internal spacing/formatting.
function normaliseOutput(s) {
  return String(s == null ? '' : s)
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map(function(line) { return line.replace(/[ \t]+$/, ''); })
    .join('\n')
    .replace(/\n+$/, '');
}

// POST /api/examly/run-tests  { language, code, testcases: [{input, output, label?}] }
router.post('/run-tests', function(req, res) {
  var body = req.body || {};
  var language = body.language;
  var code = body.code;
  var testcases = Array.isArray(body.testcases) ? body.testcases : [];
  if (!language || !code) return res.status(400).json({ error: '"language" and "code" are required' });
  if (!testcases.length) return res.status(400).json({ error: '"testcases" must be a non-empty array' });

  console.log('[EXECUTE] run-tests lang=' + language + ' codeLen=' + code.length + ' testcases=' + testcases.length);

  var dir = fs.mkdtempSync(path.join(os.tmpdir(), 'testpack-run-'));

  function cleanup() {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) {}
  }

  prepare(language, code, dir).then(function(prep) {
    if (prep.compileError) {
      console.log('[EXECUTE] compile FAILED lang=' + language + ': ' + prep.compileError);
      cleanup();
      return res.json({ ok: false, compileError: prep.compileError, results: [] });
    }
    console.log('[EXECUTE] compile OK (or not needed) lang=' + language);

    // Test cases are independent (each spawns its own child process, no
    // shared mutable state) — running them concurrently instead of one at a
    // time cuts wall-clock time substantially, especially for Java where
    // every single run pays a fresh JVM startup cost.
    var runs = testcases.map(function(tc, i) {
      return prep.run(tc.input != null ? String(tc.input) : '').then(function(r) {
        if (!r.ok) {
          console.log('[EXECUTE] test #' + i + ' RUN ERROR: ' + r.error);
          return { index: i, label: tc.label || null, passed: false, error: r.error, expected: tc.output, actual: null };
        }
        var actual = normaliseOutput(r.stdout);
        var expected = normaliseOutput(tc.output);
        var passed = actual === expected;
        console.log('[EXECUTE] test #' + i + ' ' + (passed ? 'PASS' : 'FAIL') +
                    (passed ? '' : (' expected=' + JSON.stringify(tc.output) + ' actual=' + JSON.stringify(r.stdout) + (r.stderr ? ' stderr=' + JSON.stringify(r.stderr) : ''))));
        return {
          index: i, label: tc.label || null, passed: passed,
          expected: tc.output, actual: r.stdout, stderr: r.stderr || undefined
        };
      });
    });

    Promise.all(runs).then(function(results) {
      cleanup();
      var passedCount = results.filter(function(r) { return r.passed; }).length;
      console.log('[EXECUTE] done lang=' + language + ' ' + passedCount + '/' + results.length + ' passed');
      res.json({ ok: true, passedCount: passedCount, totalCount: results.length, allPassed: passedCount === results.length, results: results });
    });
  }).catch(function(err) {
    console.log('[EXECUTE] unexpected error: ' + err.message);
    cleanup();
    res.status(500).json({ error: err.message });
  });
});

module.exports = router;
