import React, { useState, useRef } from 'react';
import { useApp } from '../store/AppContext';
import { getTestQuestions, searchTests, resolveQBNames, getQBQuestions, pushSolution } from '../api/examlyAPI';
import { translateSolution, translateFragment, translateStub, fixSolution } from '../api/groqAPI';
import { runTests } from '../api/executeAPI';
import StatusMsg from '../components/StatusMsg';

// Up to this many automatic fix-and-retest rounds after the initial
// generate, using the REAL demonstrated expected-vs-actual mismatch from
// local test execution (not a guess) to fix a concrete bug. If it still
// isn't passing after this many rounds, stop and show the last failure —
// never push code that hasn't actually passed.
const MAX_FIX_ATTEMPTS = 3;

// CONFIRMED via a real captured multilanguage array on a live question:
// ["Python", "Java", "Java17", "Java21", "C++", "C"] — the versioned Java
// variants are "Java17"/"Java21" (no space, no parentheses), not the
// "Java (17)" style guessed earlier. This is the exact, complete, only set —
// no other variants (Java11, "C (17)", etc.) are supported.
const LANGUAGES = ['Python', 'Java', 'Java17', 'Java21', 'C++', 'C'];

// "Java", "Java17", "Java21" aren't different languages — they're JVM
// version tags for the SAME language, and older Java source is virtually
// always valid as-is on a newer JVM (Java is backward compatible; nothing
// requires modernizing `for` loops to `var`, try-with-resources rewrites,
// etc. for the code to WORK). CONFIRMED live, repeatedly: asking the AI to
// "translate" between these anyway doesn't modernize anything useful — it
// just introduces real bugs while doing it (an empty solution, a header
// missing a trailing semicolon, a stray leading semicolon in the solution —
// three separate corruption incidents, all specifically on a same-family
// Java-to-Java translation). Skip AI translation entirely for this case and
// copy the source verbatim — faster, and zero risk of this class of bug.
const JAVA_FAMILY = new Set(['java', 'java17', 'java21']);
function sameJavaFamily(a, b) {
  return JAVA_FAMILY.has(String(a || '').toLowerCase()) && JAVA_FAMILY.has(String(b || '').toLowerCase());
}

// The one solution marked "Best Solution" on the portal for this question
// (falls back to the first solution with code if nothing is marked best —
// covers questions from before that flag existed/was ever set). Returns
// { code, language } — code is '' if there's no solution at all.
// `hasSnippet`/`header`/`footer`/`codeStub`: CONFIRMED via a real captured
// question object — some questions wrap the student's code in a fixed
// header/footer and show a codeStub with an INTENTIONAL bug, separate from
// `code` (solutiondata[0].solution, the correct/fixed version). Most
// questions DON'T use this at all — hasSnippet is false and header/footer/
// codeStub are '' in that case, and must stay that way (never invented).
const EMPTY_BEST = { code: '', language: null, hasSnippet: false, header: '', footer: '', codeStub: '' };
function bestSolutionOf(q) {
  const sols = q.programming_question && q.programming_question.solution;
  if (!Array.isArray(sols) || !sols.length) return EMPTY_BEST;
  const isBest = s => Array.isArray(s.solutiondata) && s.solutiondata.some(sd => sd.solutionbest && sd.solution);
  const best = sols.find(isBest) || sols.find(s => Array.isArray(s.solutiondata) && s.solutiondata.some(sd => sd.solution));
  if (!best) return EMPTY_BEST;
  const sd = best.solutiondata.find(sd => sd.solution) || {};
  return {
    code: sd.solution || '', language: best.language || null,
    hasSnippet: !!best.hasSnippet, header: best.header || '', footer: best.footer || '', codeStub: best.codeStub || ''
  };
}

// Every language currently marked "Best Solution" (normally just one, per the
// portal's own semantics — see the push logic — but shown as a list in case
// an older question has more than one, or none).
function bestLanguagesOf(q) {
  const sols = q.programming_question && q.programming_question.solution;
  if (!Array.isArray(sols)) return [];
  return sols
    .filter(s => Array.isArray(s.solutiondata) && s.solutiondata.some(sd => sd.solutionbest))
    .map(s => s.language)
    .filter(Boolean);
}

// The question's real test cases — sample I/O (visible) + hidden test cases
// combined — as {input, output, label}. Both come back from the fetch as
// JSON *strings*, not arrays, so they need parsing.
function testCasesOf(q) {
  const pq = q.programming_question || {};
  const out = [];
  try {
    const samples = typeof pq.sample_io === 'string' ? JSON.parse(pq.sample_io) : (pq.sample_io || []);
    samples.forEach((t, i) => out.push({ input: t.input, output: t.output, label: `Sample ${i + 1}` }));
  } catch (e) {}
  try {
    const hidden = typeof pq.testcases === 'string' ? JSON.parse(pq.testcases) : (pq.testcases || []);
    hidden.forEach((t, i) => out.push({ input: t.input, output: t.output, label: `Test ${i + 1}${t.difficulty ? ' (' + t.difficulty + ')' : ''}` }));
  } catch (e) {}
  return out;
}

// Every language this question already has a solution for, with its code and
// whether it's marked best — not just the single best one.
function allSolutionsOf(q) {
  const sols = q.programming_question && q.programming_question.solution;
  if (!Array.isArray(sols)) return [];
  return sols
    .map(s => {
      const sd = (s.solutiondata || []).find(sd => sd.solution) || {};
      return {
        language: s.language, code: sd.solution || '', best: !!sd.solutionbest,
        hasSnippet: !!s.hasSnippet, header: s.header || '', footer: s.footer || '', codeStub: s.codeStub || ''
      };
    })
    .filter(s => s.language && s.code);
}

export default function Step6AddSolutions() {
  const { token } = useApp();

  const [testNameInput, setTestNameInput] = useState('');
  const [qbNameInput, setQbNameInput] = useState('');

  const [loadingQs, setLoadingQs] = useState(false);
  const [qStatus, setQStatus] = useState(null);
  const [testsUsed, setTestsUsed] = useState([]);
  const [questions, setQuestions] = useState([]);
  // { type: 'test'|'qb', items: [...] } when a search matched more than one
  // test/QB — shown as a picker so the user selects the exact one instead of
  // us guessing or silently pooling everything together. null when not picking.
  const [candidates, setCandidates] = useState(null);

  // id -> { code, loading, error, pushed, pushError, copied, language }
  const [gen, setGen] = useState({});
  // id -> language currently selected in that question's own dropdown
  const [pushLangByQ, setPushLangByQ] = useState({});
  // id -> which existing solution's language is currently shown in the
  // "Existing" viewer (defaults to the best one, but you can view any)
  const [viewLangByQ, setViewLangByQ] = useState({});
  // id -> true for questions checked for the bulk "Update selected" action
  const [selectedIds, setSelectedIds] = useState({});
  // Whether a bulk update run is in progress, and how far through it we are
  const [bulkRunning, setBulkRunning] = useState(false);
  const [bulkProgress, setBulkProgress] = useState(null); // { done, total }
  // The single language applied to every selected question during a bulk
  // "Update selected" run — separate from each question's own per-row
  // dropdown, so you don't have to set them one by one before bulk-running.
  const [bulkLanguage, setBulkLanguage] = useState(LANGUAGES[0]);

  // id -> AbortController for that question's in-flight generate (Stop
  // button below). Refs, not state — aborting doesn't need a re-render by
  // itself, and a new controller must be created per generate WITHOUT
  // waiting on a state update round-trip.
  const abortControllersRef = useRef({});
  // One shared controller for whichever question a bulk run ("Generate all"
  // / "Update selected") is CURRENTLY processing, so Stop can cancel the
  // in-flight request immediately instead of only stopping before the next
  // question. Paired with a plain boolean (not state) the loop polls
  // between iterations to stop moving on to further questions at all.
  const bulkAbortControllerRef = useRef(null);
  const bulkStopRequestedRef = useRef(false);

  function isAbortError(err) {
    return err && (err.name === 'CanceledError' || err.code === 'ERR_CANCELED' || err.message === 'canceled');
  }

  function languageFor(q) {
    return pushLangByQ[q.id] || LANGUAGES[0];
  }

  function toggleSelected(id) {
    setSelectedIds(prev => ({ ...prev, [id]: !prev[id] }));
  }

  function toggleSelectAll() {
    const selectableIds = questions.filter(q => bestSolutionOf(q).code && !q.qbUnresolved).map(q => q.id);
    const allSelected = selectableIds.length > 0 && selectableIds.every(id => selectedIds[id]);
    const next = {};
    if (!allSelected) {
      selectableIds.forEach(id => { next[id] = true; });
      // Sync the already-chosen bulk language onto every newly-selected
      // question's own dropdown too — keeps this consistent whether you pick
      // the language before or after checking "Select all".
      setPushLangByQ(prev => {
        const langNext = { ...prev };
        selectableIds.forEach(id => { langNext[id] = bulkLanguage; });
        return langNext;
      });
    }
    setSelectedIds(next);
  }

  // Shared reset before any load (search, or a picker selection).
  function resetForLoad() {
    setQStatus(null);
    setQuestions([]);
    setTestsUsed([]);
    setGen({});
    setPushLangByQ({});
    setCandidates(null);
  }

  async function loadTestByName(name) {
    setLoadingQs(true);
    resetForLoad();
    try {
      const res = await getTestQuestions(token, name);
      const pool = res.data || [];
      setQuestions(pool);
      setTestsUsed(res.tests || [name]);
      const notFoundCount = res.notFound?.length || 0;
      // `zeroQuestionIds` (server): the matched test object(s) themselves had
      // no question ids to extract at all — different from ids being
      // extracted but not found in any visible QB, so worth telling apart.
      const matchedNames = (res.tests || [name]).join(', ');
      setQStatus({
        type: pool.length ? (notFoundCount ? 'warn' : 'ok') : 'warn',
        msg: pool.length
          ? `Loaded ${pool.length} of ${res.requested} question(s) from test "${matchedNames}".` +
            (notFoundCount ? ` ${notFoundCount} question(s) could not be located in any QB you can see.` : '')
          : res.zeroQuestionIds
            ? `Test "${matchedNames}" matched, but it has no questions attached on the portal.`
            : `Test "${name}" matched, but none of its questions could be located in any QB you can see — check you have access to the QB(s) it draws from.`
      });
    } catch (err) {
      setQStatus({ type: 'err', msg: err.response?.data?.error || err.message });
    } finally {
      setLoadingQs(false);
    }
  }

  async function loadQB(qb) {
    setLoadingQs(true);
    resetForLoad();
    try {
      const r = await getQBQuestions(token, qb.id, qb.name);
      const pool = (r.data || []).map(q => ({ ...q, qbId: qb.id, qbName: qb.name }));
      setQuestions(pool);
      setTestsUsed([qb.name]);
      setQStatus({
        type: pool.length ? 'ok' : 'warn',
        msg: pool.length ? `Loaded ${pool.length} question(s) from QB "${qb.name}".` : `QB "${qb.name}" matched but has no questions.`
      });
    } catch (err) {
      setQStatus({ type: 'err', msg: err.response?.data?.error || err.message });
    } finally {
      setLoadingQs(false);
    }
  }

  // Either a test name OR a QB name works — whichever you actually have on
  // hand. Searches first (every match, not auto-resolved to one) — a single
  // match loads straight away; more than one shows a picker so you select
  // the exact test/QB instead of us guessing or silently pooling them all
  // together (e.g. "...Day 19_PAH" vs "...Day 19_CE" — sibling tests in the
  // same series would otherwise get merged into one confusing result).
  async function handleFind() {
    // Re-entrancy guard: the Find button is disabled while loadingQs, but
    // that's a React re-render behind the click — a held-down/rapid Enter
    // key in either input (both call handleFind on keydown, unconditionally)
    // could fire a second search before the disabled state actually applied.
    // CONFIRMED live: without this, duplicate concurrent searches for the
    // same test each independently re-ran the entire expensive resolution
    // pipeline, multiplying load and 429s. See also the input `disabled`
    // props below, which stop Enter from refiring in the first place.
    if (loadingQs) return;

    const testName = testNameInput.trim();
    const qbName = qbNameInput.trim();
    if (!testName && !qbName) { setQStatus({ type: 'err', msg: 'Enter a test name or a QB name.' }); return; }

    setLoadingQs(true);
    resetForLoad();

    try {
      if (qbName) {
        const resolved = await resolveQBNames(token, [qbName]);
        const qbs = resolved.data || [];
        if (!qbs.length) {
          setQStatus({ type: 'err', msg: `No QB found matching "${qbName}".` });
          setLoadingQs(false);
          return;
        }
        if (qbs.length === 1) { await loadQB(qbs[0]); return; }
        setCandidates({ type: 'qb', items: qbs });
        setQStatus({ type: 'warn', msg: `${qbs.length} QBs match "${qbName}" — pick the one you mean below.` });
        setLoadingQs(false);
        return;
      }

      const searchRes = await searchTests(token, testName);
      const testMatches = searchRes.data || [];
      if (!testMatches.length) {
        setQStatus({ type: 'err', msg: `No test found matching "${testName}".` });
        setLoadingQs(false);
        return;
      }
      if (testMatches.length === 1) { await loadTestByName(testMatches[0].name); return; }
      setCandidates({ type: 'test', items: testMatches });
      setQStatus({ type: 'warn', msg: `${testMatches.length} tests match "${testName}" — pick the one you mean below.` });
      setLoadingQs(false);
    } catch (err) {
      setQStatus({ type: 'err', msg: err.response?.data?.error || err.message });
      setLoadingQs(false);
    }
  }

  // Runs code against the question's real test cases; on failure, asks Groq
  // to fix it using the ACTUAL demonstrated expected-vs-actual mismatch (not
  // a guess), then re-tests — up to MAX_FIX_ATTEMPTS times. Whatever the
  // final result is (pass or still-failing) is left in `gen[q.id].runResult`
  // so Push can be gated on it: never push code that hasn't actually passed.
  // Returns { passed, code } — the code is the FINAL (possibly fixed)
  // version, so bulk operations can push it directly instead of reading back
  // potentially-stale `gen` state (see pushFor's `override` param).
  // `snippet` (optional): { header, footer } — when present, `initialCode` is
  // only the MIDDLE portion. Tests run against header+code+footer
  // concatenated (a real compileable program), but any auto-fix keeps
  // operating on just the middle (see fixSolution's header/footer params) —
  // so header/footer never drift from what was actually translated.
  async function verifyAndFix(q, initialCode, language, snippet, signal) {
    const cases = testCasesOf(q);
    if (!cases.length) {
      setGen(prev => ({ ...prev, [q.id]: { ...prev[q.id], runError: 'No test cases found on this question — cannot verify automatically.' } }));
      return { passed: true, unverifiable: true, code: initialCode }; // nothing to check against — don't block push on this alone
    }

    const header = snippet && snippet.header ? snippet.header : '';
    const footer = snippet && snippet.footer ? snippet.footer : '';
    const fullOf = mid => (header ? header + '\n\n' : '') + mid + (footer ? '\n\n' + footer : '');

    let code = initialCode;
    for (let attempt = 0; attempt <= MAX_FIX_ATTEMPTS; attempt++) {
      setGen(prev => ({ ...prev, [q.id]: { ...prev[q.id], running: true, runError: null, fixAttempt: attempt } }));
      let rr;
      try {
        rr = await runTests(language, fullOf(code), cases, signal);
      } catch (err) {
        if (isAbortError(err)) { setGen(prev => ({ ...prev, [q.id]: { ...prev[q.id], running: false, stopped: true } })); return { passed: false, code, stopped: true }; }
        setGen(prev => ({ ...prev, [q.id]: { ...prev[q.id], running: false, runError: err.response?.data?.error || err.message } }));
        return { passed: false, code };
      }

      var failures;
      if (rr.compileError) {
        setGen(prev => ({ ...prev, [q.id]: { ...prev[q.id], running: false, runResult: null, runError: 'Compile error: ' + rr.compileError } }));
        if (attempt >= MAX_FIX_ATTEMPTS) return { passed: false, code };
        failures = [{ input: '(compiling)', expected: 'compiles successfully', actual: rr.compileError, label: 'Compile error' }];
      } else {
        setGen(prev => ({ ...prev, [q.id]: { ...prev[q.id], running: false, runResult: rr, runError: null } }));
        if (rr.allPassed) return { passed: true, code };
        if (attempt >= MAX_FIX_ATTEMPTS) return { passed: false, code };
        failures = rr.results.filter(r => !r.passed).map(r => ({
          input: cases[r.index] ? cases[r.index].input : '',
          expected: r.expected, actual: r.actual != null ? r.actual : r.error, label: r.label
        }));
      }

      setGen(prev => ({ ...prev, [q.id]: { ...prev[q.id], fixing: true } }));
      let fixRes;
      try {
        fixRes = await fixSolution({ code, language, question_text: q.title, failures, header, footer }, signal);
      } catch (err) {
        if (isAbortError(err)) { setGen(prev => ({ ...prev, [q.id]: { ...prev[q.id], fixing: false, stopped: true } })); return { passed: false, code, stopped: true }; }
        setGen(prev => ({ ...prev, [q.id]: { ...prev[q.id], fixing: false, runError: err.response?.data?.error || err.message } }));
        return { passed: false, code };
      }
      setGen(prev => ({ ...prev, [q.id]: { ...prev[q.id], fixing: false } }));
      if (!fixRes.ok) {
        setGen(prev => ({ ...prev, [q.id]: { ...prev[q.id], runError: fixRes.error || 'Fix attempt failed' } }));
        return { passed: false, code };
      }
      code = fixRes.code;
      setGen(prev => ({ ...prev, [q.id]: { ...prev[q.id], code } }));
    }
    return { passed: false, code };
  }

  // `languageOverride` (optional): use this language instead of reading the
  // question's own dropdown — needed for the bulk run, which applies ONE
  // chosen language across every selected question and (like pushFor's
  // override) can't rely on state read through this function's closure
  // staying fresh across a long-running loop.
  // Returns { passed, code, language } (see verifyAndFix) so bulk operations
  // know whether — and with exactly what — to push, or { passed: false }
  // if translation itself failed.
  // `externalSignal` (optional): when a bulk run ("Generate all" / "Update
  // selected") is driving this call, it supplies its OWN shared
  // AbortController's signal so its single Stop button cancels whichever
  // question is currently in flight — generateFor doesn't create its own
  // controller in that case. Standalone (clicking Generate on one row)
  // creates and owns its own controller, stored in abortControllersRef so
  // this row's own Stop button can abort just this one.
  async function generateFor(q, languageOverride, externalSignal) {
    const best = bestSolutionOf(q);
    // Capture the target language NOW — if this question's dropdown changes
    // before this resolves, or before Push is clicked, the generated code
    // must stay paired with the language it was actually generated in.
    const targetLanguage = languageOverride || languageFor(q);
    const ownController = externalSignal ? null : new AbortController();
    if (ownController) abortControllersRef.current[q.id] = ownController;
    const signal = externalSignal || (ownController && ownController.signal);
    // Reset pushed/pushError — without this, once ANY language had been
    // pushed for this question, the Push button stayed disabled forever
    // (e.pushed never went back to false), blocking pushing a second,
    // different language for the same question afterward. Also reset any
    // previous run result, since it belonged to the old code.
    setGen(prev => ({ ...prev, [q.id]: { ...prev[q.id], loading: true, error: null, stopped: false, pushed: false, pushError: null, runResult: null, runError: null, fixAttempt: 0 } }));
    try {
      // Same-family Java shortcut — see JAVA_FAMILY comment above. Applies
      // whether or not this question uses the header/footer/codeStub
      // pattern: either way, the source is ALREADY valid Java for the
      // target version, so there's nothing to translate — copy verbatim.
      if (sameJavaFamily(best.language, targetLanguage)) {
        setGen(prev => ({ ...prev, [q.id]: {
          ...prev[q.id], code: best.code, language: targetLanguage, loading: false, error: null,
          hasSnippet: best.hasSnippet, header: best.header, footer: best.footer, codeStub: best.codeStub
        } }));
        const snippet = (best.header || best.footer) ? { header: best.header, footer: best.footer } : undefined;
        const result = await verifyAndFix(q, best.code, targetLanguage, snippet, signal);
        return { ...result, language: targetLanguage, hasSnippet: best.hasSnippet, header: best.header, footer: best.footer, codeStub: best.codeStub };
      }

      // Detect on actual header/footer/codeStub CONTENT, not the `hasSnippet`
      // flag — CONFIRMED via a real captured question: hasSnippet can be
      // false while codeStub still holds real content, so the flag alone
      // misses it. When any of these is present, they must be TRANSLATED
      // into the target language along with solution — copying the source
      // language's header/footer/codeStub verbatim into a different
      // language's entry doesn't compile and is meaningless to a student.
      const usesSnippetFields = !!(best.header || best.footer || best.codeStub);
      if (usesSnippetFields) {
        const fromLanguage = best.language || 'the original language';
        // Three separate plain code-in/code-out calls, not one combined
        // JSON blob — CONFIRMED live that the JSON approach was unreliable
        // (the model had to correctly distinguish a real line break from a
        // literal "\n" already inside the code, e.g. in a printf string, and
        // got it wrong across the board, turning the whole file into one
        // line that then failed to compile). Solution first, since the stub
        // translation needs it as context to match naming/structure.
        const solRes = await translateSolution({
          code: best.code || '', fromLanguage, toLanguage: targetLanguage, question_text: q.title
        }, signal);
        if (!solRes.ok) throw new Error(solRes.error || 'Translation failed');

        // Sequential, not Promise.all — CONFIRMED live that 4 Groq calls per
        // question (solution + these 3) bursting at once trips Groq's rate
        // limit (429s), especially across several questions in a row. A bit
        // slower per question, but far fewer rate-limit failures overall.
        const headerRes = best.header
          ? await translateFragment({ code: best.header, fromLanguage, toLanguage: targetLanguage, kind: 'header' }, signal)
          : { ok: true, code: '' };
        if (!headerRes.ok) throw new Error(headerRes.error || 'Header translation failed');

        const footerRes = best.footer
          ? await translateFragment({ code: best.footer, fromLanguage, toLanguage: targetLanguage, kind: 'footer' }, signal)
          : { ok: true, code: '' };
        if (!footerRes.ok) throw new Error(footerRes.error || 'Footer translation failed');

        const stubRes = best.codeStub
          ? await translateStub({
              codeStub: best.codeStub, originalSolution: best.code || '', translatedSolution: solRes.code,
              fromLanguage, toLanguage: targetLanguage, question_text: q.title
            }, signal)
          : { ok: true, code: '' };
        if (!stubRes.ok) throw new Error(stubRes.error || 'Code stub translation failed');

        // hasSnippet is carried over from the SOURCE as-is (it's an
        // independent flag from "has a codeStub" — never recomputed here).
        setGen(prev => ({ ...prev, [q.id]: {
          ...prev[q.id], code: solRes.code, language: targetLanguage, loading: false, error: null,
          hasSnippet: best.hasSnippet, header: headerRes.code, footer: footerRes.code, codeStub: stubRes.code
        } }));
        const result = await verifyAndFix(q, solRes.code, targetLanguage, { header: headerRes.code, footer: footerRes.code }, signal);
        return { ...result, language: targetLanguage, hasSnippet: best.hasSnippet, header: headerRes.code, footer: footerRes.code, codeStub: stubRes.code };
      }
      const res = await translateSolution({
        code: best.code || '',
        fromLanguage: best.language || 'the original language',
        toLanguage: targetLanguage,
        question_text: q.title
      }, signal);
      if (!res.ok) throw new Error(res.error || 'Translation failed');
      setGen(prev => ({ ...prev, [q.id]: { ...prev[q.id], code: res.code, language: targetLanguage, loading: false, error: null, hasSnippet: false, header: '', footer: '', codeStub: '' } }));
      const result = await verifyAndFix(q, res.code, targetLanguage, undefined, signal);
      return { ...result, language: targetLanguage, hasSnippet: false };
    } catch (err) {
      if (isAbortError(err)) {
        setGen(prev => ({ ...prev, [q.id]: { ...prev[q.id], loading: false, stopped: true } }));
        return { passed: false, stopped: true };
      }
      setGen(prev => ({ ...prev, [q.id]: { ...prev[q.id], loading: false, error: err.response?.data?.error || err.message } }));
      return { passed: false };
    } finally {
      if (ownController) delete abortControllersRef.current[q.id];
    }
  }

  // Aborts a specific question's own in-flight generate (only meaningful
  // when it owns its own controller — i.e. not currently driven by a bulk
  // run, which uses stopBulk() instead since it shares one controller).
  function stopFor(q) {
    var controller = abortControllersRef.current[q.id];
    if (controller) controller.abort();
  }

  async function generateAll() {
    const targets = questions.filter(q => bestSolutionOf(q).code);
    if (!targets.length) return;

    bulkStopRequestedRef.current = false;
    setBulkRunning(true);
    setBulkProgress({ done: 0, total: targets.length });
    for (let i = 0; i < targets.length; i++) {
      if (bulkStopRequestedRef.current) break;
      const q = targets[i];
      const controller = new AbortController();
      bulkAbortControllerRef.current = controller;
      await generateFor(q, undefined, controller.signal);
      bulkAbortControllerRef.current = null;
      setBulkProgress({ done: i + 1, total: targets.length });
    }
    setBulkRunning(false);
    bulkStopRequestedRef.current = false;
  }

  // Cancels whichever bulk run ("Generate all" / "Update selected") is
  // currently in progress: aborts the CURRENTLY in-flight request via the
  // shared controller, and stops the loop from starting any further
  // question. A question already pushed stays pushed — only the questions
  // not yet reached are skipped.
  function stopBulk() {
    bulkStopRequestedRef.current = true;
    if (bulkAbortControllerRef.current) bulkAbortControllerRef.current.abort();
  }

  // Runs the FULL pipeline (generate -> verify -> auto-fix -> push) for every
  // currently-selected question, one at a time — pushes hit your live portal,
  // so this deliberately doesn't parallelize. Passes the freshly-produced
  // code/language straight to pushFor's override instead of relying on `gen`
  // state, which would otherwise be stale inside this same long-running loop
  // (see pushFor's comment).
  async function updateSelected() {
    const ids = Object.keys(selectedIds).filter(id => selectedIds[id]);
    const targets = questions.filter(q => ids.includes(String(q.id)) && bestSolutionOf(q).code && !q.qbUnresolved);
    if (!targets.length) return;

    bulkStopRequestedRef.current = false;
    setBulkRunning(true);
    setBulkProgress({ done: 0, total: targets.length });
    for (let i = 0; i < targets.length; i++) {
      if (bulkStopRequestedRef.current) break;
      const q = targets[i];
      // Reflect the bulk language choice in this question's own dropdown too
      // (display only — generateFor gets it explicitly below, so this can't
      // introduce the same staleness issue the override params exist to avoid).
      setPushLangByQ(prev => ({ ...prev, [q.id]: bulkLanguage }));
      const controller = new AbortController();
      bulkAbortControllerRef.current = controller;
      const result = await generateFor(q, bulkLanguage, controller.signal);
      bulkAbortControllerRef.current = null;
      if (bulkStopRequestedRef.current) { setBulkProgress({ done: i + 1, total: targets.length }); break; }
      if (result.passed) {
        await pushFor(q, {
          code: result.code, language: result.language,
          hasSnippet: result.hasSnippet, header: result.header, footer: result.footer, codeStub: result.codeStub
        });
      }
      setBulkProgress({ done: i + 1, total: targets.length });
    }
    setBulkRunning(false);
    bulkStopRequestedRef.current = false;
  }

  function editCode(id, code) {
    // A manual edit invalidates any prior run result — it was for the old code.
    setGen(prev => ({ ...prev, [id]: { ...prev[id], code, runResult: null, runError: null } }));
  }

  async function runTestsFor(q) {
    const entry = gen[q.id];
    if (!entry?.code) return;
    const language = entry.language || languageFor(q);
    const snippet = (entry.header || entry.footer) ? { header: entry.header, footer: entry.footer } : undefined;
    const controller = new AbortController();
    abortControllersRef.current[q.id] = controller;
    setGen(prev => ({ ...prev, [q.id]: { ...prev[q.id], stopped: false } }));
    try {
      await verifyAndFix(q, entry.code, language, snippet, controller.signal);
    } finally {
      delete abortControllersRef.current[q.id];
    }
  }

  async function copyFor(q) {
    const entry = gen[q.id];
    if (!entry?.code) return;
    try {
      await navigator.clipboard.writeText(entry.code);
      setGen(prev => ({ ...prev, [q.id]: { ...prev[q.id], copied: true } }));
      setTimeout(() => setGen(prev => ({ ...prev, [q.id]: { ...prev[q.id], copied: false } })), 2000);
    } catch (err) {
      setGen(prev => ({ ...prev, [q.id]: { ...prev[q.id], error: 'Could not copy — select the text in the box above and copy it manually.' } }));
    }
  }

  // `override` (optional): { code, language } to push directly instead of
  // reading gen[q.id]. Needed for the bulk "Update selected" loop below —
  // within one already-running async function, `gen` in this closure stays
  // whatever it was when the function was called; the setGen calls made
  // inside generateFor/verifyAndFix during that same loop iteration don't
  // retroactively update it (React only gives you a fresh closure on the
  // next render). Passing the freshly-produced result straight through
  // avoids reading back stale state.
  async function pushFor(q, override) {
    const entry = override || gen[q.id];
    if (!entry?.code) return false;
    // Use the language this code was actually generated in — NOT whatever
    // this question's dropdown currently shows, which may have changed since
    // Generate was clicked.
    const pushLanguage = entry.language || languageFor(q);
    // Only send translated snippet fields when THIS generated code actually
    // has header/footer/codeStub content (from generateFor's snippet
    // branch) — gated on actual content, not the `hasSnippet` flag, which can
    // be false while codeStub still holds real content (CONFIRMED via a real
    // captured question). Never invent this for a plain question.
    const hasSnippetContent = !!(entry.header || entry.footer || entry.codeStub);
    const snippetExtra = hasSnippetContent
      ? { snippet: { hasSnippet: !!entry.hasSnippet, header: entry.header || '', footer: entry.footer || '', codeStub: entry.codeStub || '' } }
      : { snippet: { hasSnippet: false } };
    setGen(prev => ({ ...prev, [q.id]: { ...prev[q.id], pushing: true, pushError: null } }));
    try {
      await pushSolution(token, q.id, pushLanguage, entry.code, {
        qbId: q.qbId,
        // CONFIRMED via a real captured "edit solution" request: this
        // endpoint is a full-object save, not a narrow solution patch — the
        // portal's edit form sends back nearly every field the question has
        // (blooms_taxonomy, subject/topic ids, tags, sample_io, testcases,
        // etc.), not just language/code. Rather than hand-forward each one,
        // send the ENTIRE raw fetched question object — mapQuestion spreads
        // the portal's raw fields through untouched (both top-level and
        // under programming_question), so it's all still here.
        rawQuestion: q,
        ...snippetExtra
      });
      setGen(prev => ({ ...prev, [q.id]: { ...prev[q.id], pushing: false, pushed: true } }));
      // Fold the just-pushed language into this question's LOCAL cached data
      // too, not just the portal. Without this, pushing a second language for
      // the same question (without re-searching in between) would send this
      // stale, pre-push snapshot as rawQuestion — one that doesn't know the
      // first language was ever added — and the server would rebuild the
      // solution array from it, silently dropping that first language back
      // out on the portal.
      setQuestions(prevQs => prevQs.map(item => {
        if (item.id !== q.id) return item;
        const pq = item.programming_question || {};
        // Whichever language is being pushed becomes the best solution —
        // "Best Solution" is one choice across the WHOLE question, not
        // per-language — clear every other language's flag first, mirroring
        // the server's merge logic, so the local cache doesn't drift out of
        // sync with what actually gets sent on the next push.
        const rawSolutionArr = Array.isArray(pq.solution) ? pq.solution : [];
        const solutionArr = rawSolutionArr.map(s => ({
          ...s,
          solutiondata: Array.isArray(s.solutiondata) ? s.solutiondata.map(sd => ({ ...sd, solutionbest: false })) : s.solutiondata
        }));
        const sIdx = solutionArr.findIndex(s => String(s.language).toLowerCase() === String(pushLanguage).toLowerCase());
        const prevEntry = sIdx !== -1 ? solutionArr[sIdx] : null;
        // Mirror the server's own rule exactly: use THIS push's actual
        // header/footer/codeStub (already translated into pushLanguage by
        // generateFor, gated on real content, never the `hasSnippet` flag
        // alone) — only fall back to the pre-existing SAME-language entry's
        // own values when this push didn't carry any (e.g. a manual edit
        // that never re-ran generateFor). Never copy another language's
        // header/footer/codeStub in verbatim — that doesn't compile.
        const newSolEntry = hasSnippetContent
          ? {
              language: pushLanguage, hasSnippet: !!entry.hasSnippet,
              header: entry.header || (prevEntry && prevEntry.header) || '',
              footer: entry.footer || (prevEntry && prevEntry.footer) || '',
              codeStub: entry.codeStub || (prevEntry && prevEntry.codeStub) || '',
              solutiondata: [{ solution: entry.code, solutionExp: null, solutionbest: true, isSolutionExp: false, solutionDebug: null }],
              hideHeader: prevEntry ? !!prevEntry.hideHeader : false, hideFooter: prevEntry ? !!prevEntry.hideFooter : false
            }
          : {
              language: pushLanguage, codeStub: '', hasSnippet: false,
              solutiondata: [{ solution: entry.code, solutionExp: null, solutionbest: true, isSolutionExp: false, solutionDebug: null }],
              hideHeader: false, hideFooter: false
            };
        if (sIdx === -1) solutionArr.push(newSolEntry);
        else solutionArr[sIdx] = { ...solutionArr[sIdx], ...newSolEntry };

        const newMultilang = Array.isArray(item.multilanguage) ? item.multilanguage.slice() : [];
        if (!newMultilang.some(l => String(l).toLowerCase() === String(pushLanguage).toLowerCase())) newMultilang.push(pushLanguage);

        return {
          ...item,
          multilanguage: newMultilang,
          programming_question: { ...pq, solution: solutionArr, multilanguage: newMultilang }
        };
      }));
      return true;
    } catch (err) {
      setGen(prev => ({
        ...prev,
        [q.id]: {
          ...prev[q.id], pushing: false,
          pushError: err.response?.data?.error || err.message
        }
      }));
      return false;
    }
  }

  const readyToPush = questions.filter(q => gen[q.id]?.code && !gen[q.id]?.pushed);

  return (
    <div className="step-content">
      <div className="card">
        <h2 className="card-title">Add solutions to a Test</h2>
        <p className="card-desc">
          Give either a test name or a QB name — whichever you have. Every question that already has a solution
          gets a new one generated in whatever language you pick per question, for you to review before pushing.
        </p>

        <div className="config-grid" style={{ gridTemplateColumns: '1fr auto 1fr' }}>
          <div className="field">
            <label className="field-label">Test name</label>
            <input
              className="input"
              placeholder="e.g. Java Backend Assessment — Batch 2026"
              value={testNameInput}
              onChange={e => setTestNameInput(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') handleFind(); }}
              disabled={loadingQs}
            />
          </div>
          <div className="or-divider">or</div>
          <div className="field">
            <label className="field-label">QB name</label>
            <input
              className="input"
              placeholder="e.g. NeoColab_Java_COD_Array of Objects"
              value={qbNameInput}
              onChange={e => setQbNameInput(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') handleFind(); }}
              disabled={loadingQs}
            />
          </div>
        </div>

        <button className="btn btn-primary" onClick={handleFind} disabled={loadingQs}>
          {loadingQs ? 'Loading...' : '🔎 Find'}
        </button>

        {loadingQs && <StatusMsg loading>Resolving question(s)...</StatusMsg>}
        {!loadingQs && qStatus && <StatusMsg type={qStatus.type}>{qStatus.msg}</StatusMsg>}

        {!loadingQs && candidates && (
          <div className="qb-list" style={{ marginTop: '10px' }}>
            {candidates.items.map(item => (
              <div
                key={item.id}
                className="qb-row"
                onClick={() => candidates.type === 'test' ? loadTestByName(item.name) : loadQB(item)}
              >
                <span className="qb-name">{item.name}</span>
                <span className="muted-note">
                  {candidates.type === 'test'
                    ? `${item.questionCount ?? '?'} question(s)${item.publishStatus ? ' · ' + item.publishStatus : ''}`
                    : `${item.questionCount ?? '?'} question(s)${item.code ? ' · ' + item.code : ''}`}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>

      {!loadingQs && questions.length > 0 && (
        <div className="card">
          <div className="list-header">
            <span className="list-title">{testsUsed.join(', ')} <span className="count-badge">{questions.length}</span></span>
            <div className="list-actions">
              <label className="check-label">
                <input
                  type="checkbox"
                  checked={questions.some(q => bestSolutionOf(q).code && !q.qbUnresolved) && questions.filter(q => bestSolutionOf(q).code && !q.qbUnresolved).every(q => selectedIds[q.id])}
                  onChange={toggleSelectAll}
                  disabled={bulkRunning}
                />
                Select all
              </label>
              <button className="btn btn-xs btn-secondary" onClick={generateAll} disabled={bulkRunning}>⚡ Generate all</button>
              <select
                className="input select select-inline"
                value={bulkLanguage}
                onChange={ev => {
                  const lang = ev.target.value;
                  setBulkLanguage(lang);
                  // Sync every SELECTED question's own dropdown to match right
                  // away, so it's visibly confirmed before you even click
                  // Update — otherwise each question's "Generated" section
                  // kept showing whatever language it last had, making it
                  // look like the bulk language pick did nothing.
                  setPushLangByQ(prev => {
                    const next = { ...prev };
                    Object.keys(selectedIds).forEach(id => { if (selectedIds[id]) next[id] = lang; });
                    return next;
                  });
                }}
                disabled={bulkRunning}
                title="Language applied to every selected question"
              >
                {LANGUAGES.map(l => <option key={l} value={l}>{l}</option>)}
              </select>
              <button
                className="btn btn-xs btn-success"
                onClick={updateSelected}
                disabled={bulkRunning || !Object.values(selectedIds).some(Boolean)}
              >
                {bulkRunning
                  ? `Updating ${bulkProgress ? bulkProgress.done : 0}/${bulkProgress ? bulkProgress.total : 0}...`
                  : `🚀 Update selected (${Object.values(selectedIds).filter(Boolean).length})`}
              </button>
              {bulkRunning && (
                <button className="btn btn-xs btn-danger" onClick={stopBulk}>⏹ Stop</button>
              )}
            </div>
          </div>
          {bulkRunning && (
            <StatusMsg loading>
              Running one question at a time — generate, verify, auto-fix, push ({bulkProgress?.done || 0}/{bulkProgress?.total || 0} done)...
            </StatusMsg>
          )}

          {questions.map((q, qIdx) => {
            const e = gen[q.id] || {};
            const best = bestSolutionOf(q);
            const bestLangs = bestLanguagesOf(q);
            const targetLanguage = languageFor(q);
            const allSols = allSolutionsOf(q);
            const viewLang = viewLangByQ[q.id] || best.language;
            const viewing = allSols.find(s => s.language === viewLang) || best;
            // The dropdown changed since this code was generated — it no
            // longer matches what's shown/would be pushed. Confirmed live:
            // leaving Run tests / Push enabled here let a push through
            // silently using the STALE language (the one actually generated
            // in, per our own safety check), while the user believed they
            // were testing/pushing the NEW dropdown language — no new
            // language ever got added, with no error to explain why.
            const languageMismatch = !!(e.code && e.language && e.language !== targetLanguage);
            // If this question has real test cases, Push requires an actual
            // passing run first — never push code that hasn't demonstrably
            // worked. Questions with no test cases to check against can't be
            // verified at all, so they fall back to the language-match-only
            // rule (nothing to gate on).
            const canVerify = testCasesOf(q).length > 0;
            const verified = !canVerify || (e.runResult && e.runResult.allPassed);
            return (
              <div key={q.id} className="subcard">
                <div className="subcard-title">
                  {best.code && !q.qbUnresolved && (
                    <input
                      type="checkbox"
                      checked={!!selectedIds[q.id]}
                      onChange={() => toggleSelected(q.id)}
                      disabled={bulkRunning}
                    />
                  )}
                  <span className="count-badge">Q{qIdx + 1}</span>
                  {q.title}
                </div>
                <div className="muted-note" style={{ marginBottom: '10px' }}>
                  {q.qbUnresolved ? 'QB unknown' : q.qbName} · Already has solutions in: {allSols.length ? allSols.map(s => s.language + (s.best ? ' (best)' : '')).join(', ') : 'none'}
                  {!best.code && ' — no solution code found on this question'}
                  {(viewing.header || viewing.footer || viewing.codeStub) && ' · Has a header/footer/code-stub — kept exactly as-is on every push'}
                </div>

                {best.code && (
                  <div className="config-grid" style={{ gridTemplateColumns: '1fr 1fr' }}>
                    <div className="field">
                      <label className="field-label label-row">
                        <span>Existing solution ({viewing.language || 'Unknown'}{viewing.best ? ' — best' : ''})</span>
                        {allSols.length > 1 && (
                          <select
                            className="input select select-inline"
                            value={viewLang || ''}
                            onChange={ev => setViewLangByQ(prev => ({ ...prev, [q.id]: ev.target.value }))}
                          >
                            {allSols.map(s => <option key={s.language} value={s.language}>{s.language}{s.best ? ' (best)' : ''}</option>)}
                          </select>
                        )}
                      </label>
                      <textarea className="input input-mono" style={{ height: '140px' }} readOnly value={viewing.code || ''} />
                      {(viewing.header || viewing.codeStub || viewing.footer) && (
                        <div className="subcard" style={{ marginTop: '8px' }}>
                          <div className="muted-note">
                            This solution also has a header/code-stub/footer on the portal — shown in the same order as the portal, carried forward exactly as-is on every push, never regenerated.
                          </div>
                          {viewing.header && (
                            <div className="field">
                              <label className="field-label">Header</label>
                              <textarea className="input input-mono" style={{ height: '70px' }} readOnly value={viewing.header} />
                            </div>
                          )}
                          {viewing.codeStub && (
                            <div className="field">
                              <label className="field-label">Code stub (shown to students)</label>
                              <textarea className="input input-mono" style={{ height: '90px' }} readOnly value={viewing.codeStub} />
                            </div>
                          )}
                          {viewing.footer && (
                            <div className="field">
                              <label className="field-label">Footer</label>
                              <textarea className="input input-mono" style={{ height: '70px' }} readOnly value={viewing.footer} />
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                    <div className="field">
                      <label className="field-label label-row">
                        <span>
                          Generated ({e.code ? (e.language || targetLanguage) : targetLanguage})
                        </span>
                        <select
                          className="input select select-inline"
                          value={targetLanguage}
                          onChange={ev => setPushLangByQ(prev => ({ ...prev, [q.id]: ev.target.value }))}
                        >
                          {LANGUAGES.map(l => <option key={l} value={l}>{l}</option>)}
                        </select>
                      </label>
                      <textarea
                        className="input input-mono"
                        style={{ height: '140px' }}
                        value={e.code || ''}
                        placeholder="Choose a language above, then click Generate..."
                        onChange={ev => editCode(q.id, ev.target.value)}
                      />
                      {(e.header || e.codeStub || e.footer) && (
                        <div className="subcard" style={{ marginTop: '8px' }}>
                          <div className="muted-note">
                            Translated into {e.language || targetLanguage} along with the solution — shown in the same order as the portal.
                          </div>
                          {e.header && (
                            <div className="field">
                              <label className="field-label">Header</label>
                              <textarea className="input input-mono" style={{ height: '70px' }} readOnly value={e.header} />
                            </div>
                          )}
                          {e.codeStub && (
                            <div className="field">
                              <label className="field-label">Code stub (shown to students)</label>
                              <textarea className="input input-mono" style={{ height: '90px' }} readOnly value={e.codeStub} />
                            </div>
                          )}
                          {e.footer && (
                            <div className="field">
                              <label className="field-label">Footer</label>
                              <textarea className="input input-mono" style={{ height: '70px' }} readOnly value={e.footer} />
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  </div>
                )}

                {languageMismatch && (
                  <StatusMsg type="warn">
                    This code was generated in {e.language}, but the dropdown is now set to {targetLanguage} —
                    Run tests / Push are disabled until you click Generate again for {targetLanguage}.
                  </StatusMsg>
                )}
                {e.error && <StatusMsg type="err">{e.error}</StatusMsg>}
                {e.fixing && (
                  <StatusMsg loading>
                    🔧 Test case(s) failed — asking the AI to fix it using the actual failure (attempt {(e.fixAttempt || 0) + 1}/{MAX_FIX_ATTEMPTS + 1})...
                  </StatusMsg>
                )}
                {e.runError && <StatusMsg type="err">{e.runError}</StatusMsg>}
                {e.runResult && !e.fixing && (
                  <StatusMsg type={e.runResult.allPassed ? 'ok' : 'warn'}>
                    {e.runResult.passedCount}/{e.runResult.totalCount} test case(s) passed
                    {!e.runResult.allPassed && (
                      <div className="diff-block">
                        {e.runResult.results.filter(r => !r.passed).map(r => (
                          <div key={r.index} className="diff-case">
                            <span className="diff-case-label">✗ {r.label || `Case ${r.index + 1}`}</span>{r.error ? `: ${r.error}` : (
                              `\n  expected: ${JSON.stringify(r.expected)}\n  actual:   ${JSON.stringify(r.actual)}`
                            )}
                          </div>
                        ))}
                        {(e.fixAttempt || 0) >= MAX_FIX_ATTEMPTS && (
                          <div className="diff-note">Still failing after {MAX_FIX_ATTEMPTS} automatic fix attempt(s) — Push stays disabled. Edit the code manually and Run tests again, or try Generate once more.</div>
                        )}
                      </div>
                    )}
                  </StatusMsg>
                )}
                {e.code && canVerify && !verified && !e.fixing && !e.runResult && (
                  <StatusMsg type="warn">Not verified yet — click Run tests before pushing.</StatusMsg>
                )}
                {e.pushError && <StatusMsg type="err">{e.pushError}</StatusMsg>}
                {e.pushed && <StatusMsg type="ok">Pushed to the portal.</StatusMsg>}
                {e.stopped && <StatusMsg type="warn">Stopped.</StatusMsg>}
                {q.qbUnresolved && (
                  <StatusMsg type="warn">
                    Couldn't determine which QB this question lives in, so it's shown for review/generation only —
                    pushing is disabled here (missing subject/topic metadata would risk clearing those on the portal).
                    Find and push it via its QB name instead once you know it.
                  </StatusMsg>
                )}

                {best.code && (() => {
                  // Busy = actually generating/running/fixing right now, whether
                  // driven by this row's own buttons or by a bulk run currently
                  // on this question. Stop maps to whichever started it — the
                  // bulk-wide stop when a bulk run is in progress (so one click
                  // stops the whole run, not just this row), this row's own
                  // controller otherwise.
                  const busy = e.loading || e.running || e.fixing;
                  const stopHandler = bulkRunning ? stopBulk : () => stopFor(q);
                  return (
                    <div className="actions-row">
                      {busy ? (
                        <button className="btn btn-xs btn-danger" onClick={stopHandler}>⏹ Stop</button>
                      ) : (
                        <button className="btn btn-xs btn-secondary" onClick={() => generateFor(q)} disabled={bulkRunning}>
                          🤖 Generate
                        </button>
                      )}
                      {busy && (
                        <span className="muted-note">{e.loading ? 'Generating...' : e.fixing ? 'Fixing...' : 'Running...'}</span>
                      )}
                    <button className="btn btn-xs btn-secondary" onClick={() => copyFor(q)} disabled={!e.code}>
                      {e.copied ? '✓ Copied' : '📋 Copy code'}
                    </button>
                    <button className="btn btn-xs btn-secondary" onClick={() => runTestsFor(q)} disabled={!e.code || busy || languageMismatch || bulkRunning}>
                      ▶️ Run tests
                    </button>
                    <button className="btn btn-xs btn-success" onClick={() => pushFor(q)} disabled={!e.code || e.pushing || e.pushed || languageMismatch || busy || !verified || bulkRunning || q.qbUnresolved}>
                      {e.pushing ? 'Pushing...' : e.pushed ? '✓ Pushed' : '🚀 Push this one'}
                    </button>
                  </div>
                  );
                })()}
              </div>
            );
          })}

          {readyToPush.length > 0 && (
            <StatusMsg type="info">
              {readyToPush.length} question(s) have a generated solution ready but not yet pushed — push each one above
              (pushes are one at a time and hit your live portal, so there's no bulk-push button here on purpose).
            </StatusMsg>
          )}
        </div>
      )}

    </div>
  );
}
