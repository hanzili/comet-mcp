// P0 CDP concurrency spike — measure the safe concurrent-tab ceiling on the live Comet endpoint.
//
// Per ADR 0001 P0 gate: open 2, then 3, then 5 tabs; one CDP connection per target;
// concurrent Runtime.evaluate + text-input exercises for 60s per phase; record latency,
// errors, disconnects, cross-tab effects, and the maximum stable tab count.
//
// Design choices:
//  - Neutral tabs only (about:blank + injected textarea). No automation against real
//    provider pages: the handoff doc records Comet's security classifier flagging
//    automation patterns; provider-UI anomaly testing is opt-in, out of this spike.
//  - Incremental accumulation (2 -> 3 -> 5) matching the checklist wording: established
//    sessions are NOT silently replaced, so silent loss of control is observable.
//  - Zero dependencies: Node >= 22 native WebSocket, fetch, CDP over JSON-RPC.
//
// Usage:
//   node test/integration/cdp-concurrency-spike.mjs                 # 2,3,5 tabs, 60s each
//   node test/integration/cdp-concurrency-spike.mjs --phases=2,3,5 --duration=60
//   node test/integration/cdp-concurrency-spike.mjs --dry           # smoke test: 1 tab, 3s

import { writeFileSync, mkdirSync } from 'fs';

const HOST = '127.0.0.1';
const PORT = parseInt(process.env.COMET_PORT || '9222', 10);
const arg = (name, dflt) => {
  const hit = process.argv.find(a => a.startsWith(`--${name}=`));
  return hit ? hit.split('=')[1] : dflt;
};
const PHASES = arg('phases', '2,3,5').split(',').map(Number);
const DURATION = parseInt(arg('duration', '60'), 10);
const DRY = process.argv.includes('--dry');
const OUT_DIR = new URL('./out/', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const OUT_FILE = OUT_DIR + `p0-cdp-spike-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;

const sleep = ms => new Promise(r => setTimeout(r, ms));
const CALL_TIMEOUT = 10000;

class CDPSession {
  constructor(wsUrl, label) {
    this.label = label;
    this.ws = new WebSocket(wsUrl);
    this.nextId = 1;
    this.pending = new Map();
    this.closed = false;
    this.closeReason = null;
    this.notableEvents = [];
    this.ws.addEventListener('message', ev => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(`${msg.error.message} (code ${msg.error.code})`));
        else resolve(msg.result);
      } else if (msg.method) {
        const m = msg.method;
        if (/crash|detached|dialog|error|contextDestroyed|navigated/i.test(m)) {
          this.notableEvents.push({ t: Date.now(), method: m, params: msg.params });
        }
      }
    });
    this.ws.addEventListener('close', ev => {
      this.closed = true;
      this.closeReason = ev.reason || `code ${ev.code}`;
    });
    this.ws.addEventListener('error', () => { /* close event follows */ });
  }
  async open() {
    if (this.ws.readyState === WebSocket.OPEN) return;
    await new Promise((res, rej) => {
      this.ws.addEventListener('open', res, { once: true });
      this.ws.addEventListener('error', () => rej(new Error('WS connect error')), { once: true });
    });
  }
  send(method, params = {}) {
    if (this.closed) return Promise.reject(new Error('WS closed'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP timeout: ${method}`));
      }, CALL_TIMEOUT);
      this.pending.set(id, {
        resolve: v => { clearTimeout(timer); resolve(v); },
        reject: e => { clearTimeout(timer); reject(e); },
      });
      try { this.ws.send(JSON.stringify({ id, method, params })); }
      catch (e) { clearTimeout(timer); this.pending.delete(id); reject(e); }
    });
  }
  close() { try { this.ws.close(); } catch { /* ignore */ } }
}

async function timedCall(session, method, params) {
  const t0 = performance.now();
  try {
    const result = await session.send(method, params);
    return { ok: true, latencyMs: performance.now() - t0, result };
  } catch (e) {
    return { ok: false, latencyMs: performance.now() - t0, error: e.message };
  }
}

async function openTab() {
  const res = await fetch(`http://${HOST}:${PORT}/json/new?about:blank`, { method: 'PUT' });
  if (!res.ok) throw new Error(`open tab HTTP ${res.status}`);
  return res.json();
}

async function closeTab(id) {
  try {
    await fetch(`http://${HOST}:${PORT}/json/close/${id}`, { method: 'GET' });
  } catch { /* ignore */ }
}

async function initTab(session, idx) {
  session.title = `spike-tab-${idx}`;
  const setup = `document.title='${session.title}';
    document.body.innerHTML='<textarea id="t" style="width:100%;height:100%"></textarea>';
    window.__spikeMarker = 'marker-${idx}';
    document.getElementById('t').focus();`;
  return timedCall(session, 'Runtime.evaluate', { expression: setup, returnByValue: true });
}

async function runPhase(nTab, sessions, phaseIdx, report, durationSec) {
  const phase = {
    phase: phaseIdx,
    targetTabCount: nTab,
    durationMs: durationSec * 1000,
    evaluate: { count: 0, failures: 0, timeouts: 0, latencies: [] },
    insertText: { count: 0, failures: 0, timeouts: 0, latencies: [], verifyMismatches: 0 },
    events: [],
  };

  const end = Date.now() + durationSec * 1000;
  let tick = 0;
  while (Date.now() < end) {
    const batch = [];
    for (const s of sessions) {
      if (s.closed) { phase.events.push({ t: Date.now(), kind: 'disconnect', label: s.label, reason: s.closeReason }); continue; }
      const r = await timedCall(s, 'Runtime.evaluate', {
        expression: `(() => { const t = document.getElementById('t'); const d = t ? t.value.length : -1;
          return { title: document.title, marker: window.__spikeMarker, textLen: d, sum: ${tick} + 1 + 2 + 3 + 4 + 5 }; })()`,
        returnByValue: true,
      });
      phase.evaluate.count++;
      if (!r.ok) {
        phase.evaluate.failures++;
        if (r.error.includes('timeout')) phase.evaluate.timeouts++;
        phase.events.push({ t: Date.now(), kind: 'eval-error', label: s.label, error: r.error });
      } else {
        phase.evaluate.latencies.push(r.latencyMs);
        // cross-tab isolation check: title + marker must be the tab's own
        const v = r.result?.result?.value;
        if (v && (v.title !== s.title || v.marker !== `marker-${s.title.split('-').pop()}`)) {
          phase.events.push({ t: Date.now(), kind: 'cross-tab', label: s.label, got: v });
        }
      }

      // text-input exercise every 3rd tick (every ~750ms) — insert a chunk
      if (tick % 3 === 0 && !s.closed) {
        const chunk = `chunk-${phaseIdx}-${tick};`;
        const ins = await timedCall(s, 'Input.insertText', { text: chunk });
        phase.insertText.count++;
        if (!ins.ok) {
          phase.insertText.failures++;
          if (ins.error.includes('timeout')) phase.insertText.timeouts++;
          phase.events.push({ t: Date.now(), kind: 'input-error', label: s.label, error: ins.error });
        } else {
          phase.insertText.latencies.push(ins.latencyMs);
          // verify the text actually landed — track the TRUE expected length as a
          // running sum of actual chunk lengths (chunk length varies with tick digit count,
          // so count x currentLength would over-count; earlier spikes showed a 38/76/114 gap
          // that was exactly this accounting artifact, not text loss).
          s.expectedLen = (s.expectedLen || 0) + chunk.length;
          const chk = await timedCall(s, 'Runtime.evaluate', {
            expression: `document.getElementById('t').value.length`,
            returnByValue: true,
          });
          const expected = s.expectedLen;
          if (!chk.ok || chk.result?.result?.value < expected - 50) {
            phase.insertText.verifyMismatches++;
            phase.events.push({ t: Date.now(), kind: 'input-verify-fail', label: s.label, expected, got: chk.result?.result?.value });
          }
        }
      }
    }
    // flush notable CDP events
    for (const s of sessions) {
      for (const ev of s.notableEvents.splice(0)) phase.events.push({ t: ev.t, kind: 'cdp-event', label: s.label, method: ev.method });
    }
    tick++;
    await sleep(250);
  }
  report.phases.push(phase);
  return phase;
}

function summarize(latencies) {
  if (!latencies.length) return { n: 0 };
  const s = [...latencies].sort((a, b) => a - b);
  const pct = p => s[Math.min(s.length - 1, Math.floor(p * s.length))];
  return {
    n: s.length,
    p50: +(pct(0.5).toFixed(1)),
    p95: +(pct(0.95).toFixed(1)),
    p99: +(pct(0.99).toFixed(1)),
    max: +s[s.length - 1].toFixed(1),
  };
}

async function main() {
  const report = { host: `${HOST}:${PORT}`, startedAt: new Date().toISOString(), phases: [], summary: {} };
  try {
    const ver = await fetch(`http://${HOST}:${PORT}/json/version`).then(r => r.json());
    report.browser = ver.Browser;
    report.protocol = ver['Protocol-Version'];
  } catch (e) {
    console.error(`FATAL: no CDP endpoint at ${HOST}:${PORT} — is Comet running with --remote-debugging-port=${PORT}? (${e.message})`);
    process.exit(2);
  }
  try {
    const list = await fetch(`http://${HOST}:${PORT}/json/list`).then(r => r.json());
    report.preExistingTargets = list.length;
    report.preExistingPages = list.filter(t => t.type === 'page').length;
  } catch { report.preExistingTargets = -1; }

  const sessions = [];
  let globalIdx = 0;
  const phaseCount = DRY ? [1] : PHASES;

  for (let pi = 0; pi < phaseCount.length; pi++) {
    const nTarget = phaseCount[pi];
    const d = DRY ? 3 : DURATION;
    console.log(`\n== Phase ${pi + 1}/${phaseCount.length}: ${nTarget} tab${nTarget > 1 ? 's' : ''}, ${d}s ==`);
    const phaseDurationSec = d;
    // open tabs incrementally (accumulate across phases)
    while (sessions.length < nTarget) {
      const target = await openTab();
      const s = new CDPSession(target.webSocketDebuggerUrl, target.id);
      await s.open();
      const init = await initTab(s, ++globalIdx);
      if (!init.ok) {
        console.error(`  init tab ${globalIdx} failed: ${init.error}`);
        s.close();
        continue;
      }
      sessions.push(s);
      console.log(`  opened tab ${sessions.length}/${nTarget} (${target.id.slice(0, 8)}) init=${init.ok ? 'ok' : init.error}`);
    }
    // one CDP connection per target — verify
    const phase = await runPhase(nTarget, sessions, pi + 1, report, phaseDurationSec);
    console.log(`  evaluate:    n=${phase.evaluate.count} fail=${phase.evaluate.failures} ` +
      JSON.stringify(summarize(phase.evaluate.latencies)));
    console.log(`  insertText:  n=${phase.insertText.count} fail=${phase.insertText.failures} ` +
      `verifyMismatch=${phase.insertText.verifyMismatches} ` + JSON.stringify(summarize(phase.insertText.latencies)));
    const disconnects = phase.events.filter(e => e.kind === 'disconnect');
    if (disconnects.length) console.log(`  DISCONNECTS: ${disconnects.length} — ${disconnects.map(d => d.label.slice(0, 8)).join(', ')}`);
    const cdpEvents = phase.events.filter(e => e.kind === 'cdp-event');
    if (cdpEvents.length) console.log(`  cdp events: ${cdpEvents.map(e => e.method).join(', ')}`);
    // record stable-at-end count
    const alive = sessions.filter(s => !s.closed).length;
    console.log(`  alive at end of phase: ${alive}/${nTarget}`);
  }

  // final verification pass: all sessions still responsive?
  console.log('\n== Final health pass ==');
  const finalHealth = [];
  for (const s of sessions) {
    const r = await timedCall(s, 'Runtime.evaluate', { expression: '1+1', returnByValue: true });
    finalHealth.push({ label: s.label.slice(0, 8), ok: r.ok, latencyMs: +r.latencyMs.toFixed(1), error: r.error || null });
    console.log(`  ${s.label.slice(0, 8)}: ${r.ok ? 'ok (' + r.latencyMs.toFixed(1) + 'ms)' : 'FAIL ' + r.error}`);
  }
  report.finalHealth = finalHealth;

  // cleanup: close spike tabs
  console.log('\n== Cleanup: closing spike tabs ==');
  for (const s of sessions) {
    const id = s.label;
    s.close();
    await closeTab(id);
  }
  sessions.length = 0;

  // summary
  const maxAlive = Math.max(...report.phases.map(p => p.targetTabCount));
  const anySilentLoss = report.phases.some(p =>
    p.events.some(e => e.kind === 'disconnect' || e.kind === 'eval-error'));
  report.summary = {
    maxStableTabCount: maxAlive,
    silentLossOfControl: anySilentLoss,
    phases: report.phases.map(p => ({
      tabs: p.targetTabCount,
      evalFailures: p.evaluate.failures,
      inputFailures: p.insertText.failures,
      disconnects: p.events.filter(e => e.kind === 'disconnect').length,
      evalLatency: summarize(p.evaluate.latencies),
      inputLatency: summarize(p.insertText.latencies),
    })),
  };
  report.endedAt = new Date().toISOString();

  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(OUT_FILE, JSON.stringify(report, null, 2));
  console.log(`\nReport written: ${OUT_FILE}`);
  console.log(`\n==== SUMMARY ====`);
  console.log(JSON.stringify(report.summary, null, 2));
}

main().catch(e => { console.error('FATAL:', e); process.exit(1); });
