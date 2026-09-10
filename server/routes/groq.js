'use strict';
const express = require('express');
const axios = require('axios');

const router = express.Router();
const GROQ_BASE = 'https://api.groq.com/openai/v1';
const MODEL = 'openai/gpt-oss-120b';
const MAX_RETRIES = 3;

function safeJSON(text) {
  try {
    return JSON.parse(text.replace(/```json|```/g, '').trim());
  } catch (e) {
    return null;
  }
}

function wait(ms) { return new Promise(function(resolve) { setTimeout(resolve, ms); }); }

// True for connection-level failures (no HTTP response at all) — TLS/socket
// resets, timeouts, DNS blips — as opposed to a real HTTP error status from
// Groq itself. Worth a quick retry since these are almost always transient.
function isNetworkError(err) {
  if (err.response) return false; // got a real HTTP response — not a network error
  var code = err.code || '';
  return code === 'ECONNRESET' || code === 'ETIMEDOUT' || code === 'ECONNABORTED' ||
    code === 'ENOTFOUND' || code === 'EAI_AGAIN' ||
    /socket disconnected|network|TLS/i.test(err.message || '');
}

// POST /api/groq/qc-analyze
// Ported from the "QB organiser" reference tool's /api/qc-analyze — a rich
// per-question QC pass: quality rating on a 4-point scale with a reason,
// duplicate detection against other questions in the same QB, tag
// suggestions, and topic-scope alignment against user-specified
// included/excluded topics.
function qcPrompt(body) {
  var otherQList = Array.isArray(body.other_questions) ? body.other_questions : [];
  var otherQBlock = otherQList.length
    ? otherQList.map(function(o) { return '- [' + o.id + '] ' + o.text; }).join('\n')
    : '(no other questions provided for comparison)';

  var topicsIncludedBlock = (Array.isArray(body.topics_included) && body.topics_included.length)
    ? body.topics_included.join(', ') : '(not specified by user)';
  var topicsExcludedBlock = (Array.isArray(body.topics_excluded) && body.topics_excluded.length)
    ? body.topics_excluded.join(', ') : '(not specified by user)';

  var system =
    'You are a strict technical QC verifier for coding questions, evaluating one question at a time ' +
    'against a rubric. Be concise, technical, and evidence-based. Never assume correctness — check the ' +
    'code against the statement, format, and constraints.\n\n' +
    'You must return ONLY a single JSON object (no markdown fences, no prose outside the JSON) with ' +
    'exactly these fields:\n' +
    '{\n' +
    '  "one_line_logic": "<one line describing what the code actually does/the core algorithmic approach>",\n' +
    '  "rating": "<one of: Best, Average, Not Good, Many Mistakes>",\n' +
    '  "rating_reason": "<short reason for the rating, must-fix issues only>",\n' +
    '  "tags": ["<tag1>", "<tag2>", ...],  // ALL concrete technical/topic tags used in the code (e.g. "1D array", "nested loop", "conditional statements", "recursion", "string manipulation")\n' +
    '  "duplication": "<one of: None, Exact Duplicate, Logic Duplicate>",\n' +
    '  "duplication_details": "<if duplicate, name which question id(s) from the provided list it duplicates and why; else empty string>",\n' +
    '  "core_topic": "<the single main topic/concept this question is fundamentally testing>",\n' +
    '  "topic_alignment": "<one of: Aligned, Not Aligned, Unclear>",\n' +
    '  "topic_alignment_reason": "<short reason, referencing the specific included/excluded topics>"\n' +
    '}\n\n' +
    'Rating rubric (deduct rating ONLY for must-fix issues, matching this QC standard):\n' +
    '- Best: statement, format, constraints, and code are fully consistent; no must-fix issues.\n' +
    '- Average: minor should-fix issues only (e.g. missing decimal formatting note) but no must-fix issues.\n' +
    '- Not Good: one clear must-fix issue (e.g. format mismatch, missing rounding spec, constraint/complexity mismatch).\n' +
    '- Many Mistakes: multiple must-fix issues, or code does not solve the stated problem at all.\n\n' +
    'Duplication rubric: "Exact Duplicate" means near-identical wording/logic to another question in the ' +
    'provided list. "Logic Duplicate" means different wording but tests the exact same underlying logic/algorithm ' +
    'as another question in the list. Compare against the other_questions list given to you.\n\n' +
    'Topic alignment rubric:\n' +
    '- If "topics_included" is specified: check whether the code/statement uses ONLY topics from that list ' +
    '(plus reasonably assumed prerequisite basics like variables/print). Mark "Not Aligned" if it requires a ' +
    'topic/concept outside that included list.\n' +
    '- If "topics_excluded" is specified: check whether the code/statement uses ANY topic from that excluded ' +
    '(future/out-of-scope) list. Mark "Not Aligned" if any excluded topic is used.\n' +
    '- If neither list is specified, mark "Unclear" with reason "No topic scope provided by user."\n' +
    '- If both lists are specified, both conditions must pass for "Aligned".';

  var user =
    'QUESTION TYPE: ' + (body.question_type || 'unknown') + '\n' +
    'EXISTING TAGS: ' + (Array.isArray(body.existing_tags) ? body.existing_tags.join(', ') : 'none') + '\n\n' +
    'PROBLEM STATEMENT:\n' + (body.question_text || '(none)') + '\n\n' +
    'INPUT FORMAT:\n' + (body.input_format || '(none)') + '\n\n' +
    'OUTPUT FORMAT:\n' + (body.output_format || '(none)') + '\n\n' +
    'CONSTRAINTS / TEST CASES:\n' + (body.constraints || '(none)') + '\n\n' +
    'SOLUTION CODE:\n' + (body.solution_code || '(none)') + '\n\n' +
    'OTHER QUESTIONS IN THIS QUESTION BANK (for duplication check):\n' + otherQBlock + '\n\n' +
    'USER-SPECIFIED TOPICS THAT SHOULD BE INCLUDED (scope, inclusion mode): ' + topicsIncludedBlock + '\n' +
    'USER-SPECIFIED FUTURE/OUT-OF-SCOPE TOPICS THAT MUST NOT BE USED: ' + topicsExcludedBlock + '\n\n' +
    'Return the JSON object now.';

  return [{ role: 'system', content: system }, { role: 'user', content: user }];
}

function qcCall(messages, key, attempt) {
  attempt = attempt || 1;
  return axios.post(GROQ_BASE + '/chat/completions', {
    model: MODEL,
    messages: messages,
    max_tokens: 1200,
    temperature: 0.2
  }, {
    headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
    timeout: 30000
  }).then(function(r) {
    return { ok: true, content: r.data.choices[0].message.content };
  }).catch(function(err) {
    var status = err.response && err.response.status;
    if (status === 429 && attempt <= MAX_RETRIES) {
      var retryAfterHeader = Number(err.response.headers && err.response.headers['retry-after']);
      var delayMs = (retryAfterHeader > 0 ? retryAfterHeader * 1000 : Math.pow(2, attempt) * 1000);
      console.log('[GROQ] qc-analyze 429 — retrying in ' + delayMs + 'ms (attempt ' + attempt + '/' + MAX_RETRIES + ')');
      return wait(delayMs).then(function() { return qcCall(messages, key, attempt + 1); });
    }
    if (isNetworkError(err) && attempt <= MAX_RETRIES) {
      var netDelayMs = 1000 * attempt;
      console.log('[GROQ] qc-analyze network error (' + (err.code || err.message) + ') — retrying in ' + netDelayMs + 'ms (attempt ' + attempt + '/' + MAX_RETRIES + ')');
      return wait(netDelayMs).then(function() { return qcCall(messages, key, attempt + 1); });
    }
    return { ok: false, error: (status || err.message) };
  });
}

router.post('/qc-analyze', function(req, res) {
  var body = req.body || {};
  if (!body.question_text) return res.status(400).json({ error: 'Missing question_text in request body' });

  var key = process.env.GROQ_API_KEY;
  if (!key || key.indexOf('xxx') !== -1 || key.length < 20) {
    return res.status(500).json({ error: 'No valid Groq API key configured on the server.' });
  }

  qcCall(qcPrompt(body), key).then(function(result) {
    if (!result.ok) {
      return res.status(500).json({ error: 'Groq QC analysis failed: ' + result.error });
    }
    var parsed = safeJSON(result.content.trim());
    if (!parsed) {
      return res.json({ ok: false, raw: result.content, model_used: MODEL, error: 'Could not parse AI response as JSON' });
    }
    res.json({ ok: true, analysis: parsed, model_used: MODEL });
  });
});

// POST /api/groq/translate-solution  { code, fromLanguage, toLanguage, question_text? }
// Straightforward LLM call — no unconfirmed portal endpoint involved here,
// unlike the routes in examly.js that read/write this translated code.
function translateCall(messages, key, attempt) {
  attempt = attempt || 1;
  return axios.post(GROQ_BASE + '/chat/completions', {
    model: MODEL,
    messages: messages,
    max_tokens: 2000,
    temperature: 0.1
  }, {
    headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
    timeout: 30000
  }).then(function(r) {
    return { ok: true, content: r.data.choices[0].message.content };
  }).catch(function(err) {
    var status = err.response && err.response.status;
    if (status === 429 && attempt <= MAX_RETRIES) {
      var retryAfterHeader = Number(err.response.headers && err.response.headers['retry-after']);
      var delayMs = (retryAfterHeader > 0 ? retryAfterHeader * 1000 : Math.pow(2, attempt) * 1000);
      console.log('[GROQ] translate-solution 429 — retrying in ' + delayMs + 'ms (attempt ' + attempt + '/' + MAX_RETRIES + ')');
      return wait(delayMs).then(function() { return translateCall(messages, key, attempt + 1); });
    }
    if (isNetworkError(err) && attempt <= MAX_RETRIES) {
      var netDelayMs = 1000 * attempt;
      console.log('[GROQ] translate-solution network error (' + (err.code || err.message) + ') — retrying in ' + netDelayMs + 'ms (attempt ' + attempt + '/' + MAX_RETRIES + ')');
      return wait(netDelayMs).then(function() { return translateCall(messages, key, attempt + 1); });
    }
    return { ok: false, error: (status || err.message) };
  });
}

router.post('/translate-solution', function(req, res) {
  var body = req.body || {};
  var code = body.code;
  var toLanguage = body.toLanguage;
  var fromLanguage = body.fromLanguage || 'the original language';
  var questionText = body.question_text || '';

  if (!code || !toLanguage) return res.status(400).json({ error: '"code" and "toLanguage" are required' });

  var key = process.env.GROQ_API_KEY;
  if (!key || key.indexOf('xxx') !== -1 || key.length < 20) {
    return res.status(500).json({ error: 'No valid Groq API key configured on the server.' });
  }

  // The portal's C++ judge doesn't support #include <bits/stdc++.h> — every
  // C++ translation must use standard headers instead (iostream, vector,
  // etc.), or the pushed solution won't compile on the portal even though it
  // compiles fine locally/in most judges.
  var cppConstraint = /^c\+\+/i.test(toLanguage)
    ? 'IMPORTANT: Do NOT use "#include <bits/stdc++.h>" — the portal\'s compiler does not support it. ' +
      'Use standard headers instead (e.g. #include <iostream>, #include <vector>, #include <string>, ' +
      'whichever the code actually needs) and "using namespace std;".\n'
    : '';

  // CONFIRMED live: translating FROM Python that prints a tuple/list/dict
  // directly needs to replicate Python's own repr quirks exactly, or the
  // output mismatches the judge byte-for-byte — most commonly missed: a
  // ONE-element tuple prints with a trailing comma ("(56,)"), 2+ elements
  // don't ("(3, 6, 9)"). Calling this out at translation time, not just
  // when the auto-fix loop catches it after the fact.
  var containerReprHint = /^python$/i.test(fromLanguage)
    ? 'If the original code prints a tuple/list/dict/set directly, replicate Python\'s exact textual quirks in the ' +
      'new language\'s output, not just a natural-looking equivalent: a ONE-element tuple prints with a trailing ' +
      'comma before the closing parenthesis (e.g. "(56,)"), while a tuple with 2+ elements does NOT (e.g. "(3, 6, 9)"); ' +
      'Python booleans print as "True"/"False" (capitalized); "None" prints as "None".\n'
    : '';

  var prompt =
    'Translate the following solution code from ' + fromLanguage + ' to ' + toLanguage + '.\n' +
    'Preserve the exact same logic, algorithm, and input/output behavior — change only the language, ' +
    'not what it does.\n' +
    'Do NOT include any comments anywhere in the output (no //, #, /* */, docstrings, or similar) — plain code only.\n' +
    cppConstraint +
    containerReprHint +
    (questionText ? ('For context, this solves:\n' + questionText.slice(0, 500) + '\n\n') : '\n') +
    'Original (' + fromLanguage + '):\n' + code + '\n\n' +
    'Return ONLY the ' + toLanguage + ' code — no markdown fences, no explanation, no comments about the translation.';

  translateCall([{ role: 'user', content: prompt }], key).then(function(result) {
    if (!result.ok) {
      return res.status(500).json({ error: 'Groq translation failed: ' + result.error });
    }
    var code = result.content.trim()
      .replace(/^```[a-zA-Z]*\n?/, '')
      .replace(/```$/, '')
      .trim();
    // CONFIRMED live: a translation between two very similar languages
    // (e.g. Java -> Java17) can come back empty after stripping fences —
    // the model apparently treats a near-identical target as needing no
    // real output. Silently returning ok:true with empty code cascaded
    // into a confusing downstream error (an empty solution "compiled" as
    // just header+footer with no class body, failed, then the auto-fix
    // call itself got rejected with "code is required" since there was no
    // code to fix). Treat empty output as a real failure instead.
    if (!code) {
      return res.status(500).json({ error: 'Groq returned an empty translation — try Generate again.' });
    }
    res.json({ ok: true, code: code, model: MODEL });
  });
});

// POST /api/groq/translate-fragment  { code, fromLanguage, toLanguage, kind }
// Translates a header (includes/imports before a student's solution) or a
// footer (a driver/main after it) into another language. Deliberately a
// PLAIN code-in/code-out call — no JSON envelope, no delimiters — same
// proven-reliable shape as /translate-solution above. An earlier version of
// this feature asked for header+codeStub+solution+footer together as one
// JSON object; CONFIRMED live that this was unreliable — the model had to
// correctly double-escape a stray "\n" already inside the code (e.g. inside
// a printf string) differently from a real line break, and got it wrong
// across the board, turning the entire file into one line with literal
// "\n" text that then failed to compile. A plain single-piece response has
// no such ambiguity: real newlines in the output ARE real newlines.
router.post('/translate-fragment', function(req, res) {
  var body = req.body || {};
  var code = body.code;
  var toLanguage = body.toLanguage;
  var fromLanguage = body.fromLanguage || 'the original language';
  var kind = (body.kind === 'footer') ? 'footer' : 'header'; // for prompt wording only

  if (!code || !toLanguage) return res.status(400).json({ error: '"code" and "toLanguage" are required' });

  var key = process.env.GROQ_API_KEY;
  if (!key || key.indexOf('xxx') !== -1 || key.length < 20) {
    return res.status(500).json({ error: 'No valid Groq API key configured on the server.' });
  }

  var cppConstraint = /^c\+\+/i.test(toLanguage)
    ? 'IMPORTANT: Do NOT use "#include <bits/stdc++.h>" — the portal\'s compiler does not support it. ' +
      'Use standard headers instead.\n'
    : '';

  var prompt =
    'Translate the following ' + kind + ' code from ' + fromLanguage + ' to ' + toLanguage + '. This ' + kind +
    ' is fixed boilerplate that wraps a student\'s solution — ' +
    (kind === 'header' ? 'placed BEFORE it (e.g. includes/imports)' : 'placed AFTER it (e.g. a driver/main that calls into it)') +
    ' — identical for every attempt.\n' +
    'Preserve the exact same behavior — change only the language, not what it does.\n' +
    'Do NOT include any comments anywhere in the output (no //, #, /* */, docstrings, or similar) — plain code only.\n' +
    cppConstraint +
    'Original ' + kind + ' (' + fromLanguage + '):\n' + code + '\n\n' +
    'Return ONLY the ' + toLanguage + ' ' + kind + ' code — no markdown fences, no explanation.';

  translateCall([{ role: 'user', content: prompt }], key).then(function(result) {
    if (!result.ok) {
      return res.status(500).json({ error: 'Groq fragment translation failed: ' + result.error });
    }
    var out = result.content.trim()
      .replace(/^```[a-zA-Z]*\n?/, '')
      .replace(/```$/, '')
      .trim();
    // Only called with a genuinely non-empty source header/footer, so an
    // empty result here is always a translation failure, not a legitimate
    // "nothing to translate" case — same reasoning as /translate-solution.
    if (!out) {
      return res.status(500).json({ error: 'Groq returned an empty ' + kind + ' translation — try Generate again.' });
    }
    res.json({ ok: true, code: out, model: MODEL });
  });
});

// POST /api/groq/translate-stub
// { codeStub, originalSolution, translatedSolution, fromLanguage, toLanguage, question_text? }
// Translates a codeStub (INTENTIONALLY buggy, part of a "fix the bug"
// exercise) into another language, reintroducing an EQUIVALENT mistake
// rather than the correct code. Given both the ORIGINAL (source-language)
// solution — to diff against the stub and see exactly what the mistake is —
// and the ALREADY-translated solution, so the stub's naming/structure
// matches it. Plain code-in/code-out, same reasoning as /translate-fragment.
router.post('/translate-stub', function(req, res) {
  var body = req.body || {};
  var codeStub = body.codeStub;
  var originalSolution = body.originalSolution || '';
  var translatedSolution = body.translatedSolution || '';
  var toLanguage = body.toLanguage;
  var fromLanguage = body.fromLanguage || 'the original language';
  var questionText = body.question_text || '';

  if (!codeStub || !toLanguage) return res.status(400).json({ error: '"codeStub" and "toLanguage" are required' });

  var key = process.env.GROQ_API_KEY;
  if (!key || key.indexOf('xxx') !== -1 || key.length < 20) {
    return res.status(500).json({ error: 'No valid Groq API key configured on the server.' });
  }

  var cppConstraint = /^c\+\+/i.test(toLanguage)
    ? 'IMPORTANT: Do NOT use "#include <bits/stdc++.h>" — the portal\'s compiler does not support it. ' +
      'Use standard headers instead.\n'
    : '';

  var prompt =
    'This is a "fix the bug" coding exercise. CODE STUB below (in ' + fromLanguage + ') is a version of a function ' +
    'shown to students, containing an INTENTIONAL mistake for them to find and fix. ORIGINAL SOLUTION (' + fromLanguage +
    ') is the correct version of the exact same code — compare the two to see exactly what that mistake is.\n' +
    'Produce a ' + toLanguage + ' version of CODE STUB that matches TRANSLATED SOLUTION below (the already-translated ' +
    'correct ' + toLanguage + ' code) in naming and structure, but reintroduces a mistake EQUIVALENT to the one in ' +
    'the original CODE STUB. Do NOT fix it, and do NOT invent a different bug from the original one.\n' +
    'CRITICAL: do NOT include any comments anywhere in the output (no //, #, /* */, docstrings, or similar), and ' +
    'never add a comment, docstring, print statement, or other text that mentions, explains, hints at, or ' +
    'references a bug, mistake, error, "intentional", or that this is a debugging exercise. It must read like ' +
    'ordinary, unremarkable code that happens to contain a mistake — say nothing about it, anywhere.\n' +
    cppConstraint +
    (questionText ? ('For context, this exercise is about:\n' + questionText.slice(0, 500) + '\n\n') : '\n') +
    'CODE STUB (' + fromLanguage + ', buggy):\n' + codeStub + '\n\n' +
    'ORIGINAL SOLUTION (' + fromLanguage + ', correct):\n' + (originalSolution || '(not provided)') + '\n\n' +
    'TRANSLATED SOLUTION (' + toLanguage + ', correct — match this style/naming):\n' + (translatedSolution || '(not provided)') + '\n\n' +
    'Return ONLY the ' + toLanguage + ' CODE STUB code — no markdown fences, no explanation.';

  translateCall([{ role: 'user', content: prompt }], key).then(function(result) {
    if (!result.ok) {
      return res.status(500).json({ error: 'Groq stub translation failed: ' + result.error });
    }
    var out = result.content.trim()
      .replace(/^```[a-zA-Z]*\n?/, '')
      .replace(/```$/, '')
      .trim();
    if (!out) {
      return res.status(500).json({ error: 'Groq returned an empty code-stub translation — try Generate again.' });
    }
    res.json({ ok: true, code: out, model: MODEL });
  });
});

// POST /api/groq/fix-solution  { code, language, question_text?, failures: [{input, expected, actual}] }
// Closes the generate -> run -> fix -> retest loop: feeds back the ACTUAL
// local test-execution results (server/routes/execute.js) — real expected vs
// actual output, not a guess — so the model fixes a concrete, demonstrated
// bug instead of re-guessing blind.
function fixCall(messages, key, attempt) {
  attempt = attempt || 1;
  return axios.post(GROQ_BASE + '/chat/completions', {
    model: MODEL,
    messages: messages,
    max_tokens: 2000,
    temperature: 0.1
  }, {
    headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
    timeout: 30000
  }).then(function(r) {
    return { ok: true, content: r.data.choices[0].message.content };
  }).catch(function(err) {
    var status = err.response && err.response.status;
    if (status === 429 && attempt <= MAX_RETRIES) {
      var retryAfterHeader = Number(err.response.headers && err.response.headers['retry-after']);
      var delayMs = (retryAfterHeader > 0 ? retryAfterHeader * 1000 : Math.pow(2, attempt) * 1000);
      console.log('[GROQ] fix-solution 429 — retrying in ' + delayMs + 'ms (attempt ' + attempt + '/' + MAX_RETRIES + ')');
      return wait(delayMs).then(function() { return fixCall(messages, key, attempt + 1); });
    }
    if (isNetworkError(err) && attempt <= MAX_RETRIES) {
      var netDelayMs = 1000 * attempt;
      console.log('[GROQ] fix-solution network error (' + (err.code || err.message) + ') — retrying in ' + netDelayMs + 'ms (attempt ' + attempt + '/' + MAX_RETRIES + ')');
      return wait(netDelayMs).then(function() { return fixCall(messages, key, attempt + 1); });
    }
    return { ok: false, error: (status || err.message) };
  });
}

router.post('/fix-solution', function(req, res) {
  var body = req.body || {};
  var code = body.code;
  var language = body.language;
  var questionText = body.question_text || '';
  var failures = Array.isArray(body.failures) ? body.failures : [];
  // For questions with a header/footer (see /translate-snippet): `code` here
  // is only the MIDDLE portion (the student's function), not the full
  // program — the fixed header/footer around it never change and are given
  // as read-only context so the model doesn't need to (and shouldn't) repeat
  // or alter them.
  var header = body.header || '';
  var footer = body.footer || '';

  if (!code || !language) return res.status(400).json({ error: '"code" and "language" are required' });
  if (!failures.length) return res.status(400).json({ error: '"failures" must be a non-empty array' });

  var key = process.env.GROQ_API_KEY;
  if (!key || key.indexOf('xxx') !== -1 || key.length < 20) {
    return res.status(500).json({ error: 'No valid Groq API key configured on the server.' });
  }

  var cppConstraint = /^c\+\+/i.test(language)
    ? 'IMPORTANT: Do NOT use "#include <bits/stdc++.h>" — the portal\'s compiler does not support it. Use standard headers instead.\n'
    : '';

  // CONFIRMED live: a Python solution that prints a tuple directly produces
  // Python's own repr, which has a quirk translations keep missing — a
  // single-element tuple gets a trailing comma before the closing paren
  // (e.g. "(56,)"), but a multi-element tuple doesn't (e.g. "(3, 6, 9)").
  // The auto-fix loop failed to catch this on its own even when shown the
  // exact expected-vs-actual mismatch 3 times, so it's called out explicitly
  // here now rather than left to be inferred.
  var containerReprHint =
    'If the expected output looks like it came from printing a Python tuple/list/dict/set directly, replicate ' +
    'Python\'s exact textual quirks, not just a natural-looking equivalent in this language: a ONE-element tuple ' +
    'prints with a trailing comma before the closing parenthesis (e.g. "(56,)"), while a tuple with 2+ elements ' +
    'does NOT (e.g. "(3, 6, 9)"); Python booleans print as "True"/"False" (capitalized); "None" prints as "None". ' +
    'Match the expected output character-for-character, including these edge cases.\n';

  // A pathological compile error (e.g. a badly malformed one-liner producing
  // a cascade of g++ diagnostics) can run to many KB — CONFIRMED live this
  // bloated a request enough to get 413'd. Cap each field defensively so a
  // bad compile error can never blow up the request, regardless of cause.
  var MAX_FIELD_CHARS = 3000;
  function clip(s) {
    s = String(s == null ? '' : s);
    return s.length > MAX_FIELD_CHARS ? (s.slice(0, MAX_FIELD_CHARS) + '\n...(truncated)') : s;
  }
  var failuresBlock = failures.slice(0, 5).map(function(f, i) {
    return '#' + (i + 1) + (f.label ? ' (' + f.label + ')' : '') + '\nInput:\n' + clip(f.input) +
      '\nExpected output:\n' + clip(f.expected) + '\nActual output (what your code produced):\n' + clip(f.actual);
  }).join('\n\n');

  var snippetContext = (header || footer)
    ? ('This code is only the MIDDLE portion of a larger program. It is always preceded by this fixed header ' +
       '(do not repeat it in your answer):\n' + (header || '(none)') + '\n\nand always followed by this fixed ' +
       'footer (do not repeat it in your answer):\n' + (footer || '(none)') + '\n\n')
    : '';

  var prompt =
    'This ' + language + ' solution has a bug — it fails the test cases below with a DEMONSTRATED, REAL ' +
    'mismatch between expected and actual output (not a guess, this was actually run).\n' +
    cppConstraint +
    containerReprHint +
    snippetContext +
    (questionText ? ('Problem statement:\n' + questionText.slice(0, 800) + '\n\n') : '\n') +
    'Current code' + (snippetContext ? ' (middle portion only)' : '') + ':\n' + code + '\n\n' +
    'Failing test case(s):\n' + failuresBlock + '\n\n' +
    'Fix the code so it produces exactly the expected output for these cases, while still handling every other ' +
    'case correctly. Pay close attention to exact output formatting (spacing, punctuation, line breaks) — that is ' +
    'the most common cause of a mismatch like this. Preserve the overall approach/algorithm unless the bug forces ' +
    'a different one. Do NOT include any comments anywhere in the output (no //, #, /* */, docstrings, or similar) ' +
    '— plain code only. Return ONLY the corrected ' + language + (snippetContext ? ' middle portion' : ' code') +
    ' — no markdown fences, no explanation' + (snippetContext ? ', and do NOT include the header or footer shown above' : '') + '.';

  fixCall([{ role: 'user', content: prompt }], key).then(function(result) {
    if (!result.ok) {
      return res.status(500).json({ error: 'Groq fix failed: ' + result.error });
    }
    var fixed = result.content.trim()
      .replace(/^```[a-zA-Z]*\n?/, '')
      .replace(/```$/, '')
      .trim();
    if (!fixed) {
      return res.status(500).json({ error: 'Groq returned an empty fix — try Run tests again.' });
    }
    res.json({ ok: true, code: fixed, model: MODEL });
  });
});

module.exports = router;
