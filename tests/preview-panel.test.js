const test = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const { readFileSync } = require('node:fs');
const path = require('node:path');

const panelState = require('../src/panel-state.js');
const panelStyles = readFileSync(path.join(__dirname, '..', 'plugin', 'styles.css'), 'utf8');
const panelMainSource = readFileSync(path.join(__dirname, '..', 'src', 'main.js'), 'utf8');

let preview;
test.before(async () => {
  preview = await import('../scripts/preview-panel.mjs');
});

test('panel preview covers every production top-level state', () => {
  const expectedModes = {
    disconnected: 'disconnected',
    unsaved: 'unsaved',
    'no-sequence': 'no-sequence',
    ready: 'ready',
    starting: 'starting',
    listening: 'listening',
    paused: 'paused',
    scanning: 'scanning',
    processing: 'processing',
    loading: 'loading',
    error: 'error',
  };

  for (const [state, expectedMode] of Object.entries(expectedModes)) {
    const scenario = preview.createPreviewScenario(state, 'rename');
    assert.equal(panelState.derivePanelState(scenario.input).mode, expectedMode, state);
  }
});

test('panel preview allows every real processing stage and rejects unknown values', () => {
  for (const stage of panelState.PIPELINE_STAGES) {
    assert.equal(preview.createPreviewScenario('processing', stage).job.stage, stage);
  }
  assert.equal(preview.normalizePreviewState('not-real'), 'ready');
  assert.equal(preview.normalizePreviewStage('not-real'), 'relink');
});

test('panel preview presents the project-level globally unique recording ID format', async () => {
  const html = await preview.renderIndex('processing', 'rename');
  assert.match(html, /项目名 \+ UUID/);
  assert.match(html, /318最终版-7f3c9a2e4b1d48f0a6c1e8d2b9f04a77\.wav/);
  assert.match(html, /[a-f0-9]{32}\.wav/);
  assert.doesNotMatch(html, /总序号/);
  assert.doesNotMatch(html, /总序号\s*·\s*时间/);
  assert.doesNotMatch(html, /20260902-145830/);
  assert.doesNotMatch(html, /318最终版-A02-003/);
  assert.doesNotMatch(html, /318最终版-000003/);
});

test('panel preview explains the native microphone zero-setup route', async () => {
  const html = await preview.renderIndex('ready', 'rename');
  assert.match(html, /怎么用/);
  assert.match(html, /面板自动待命/);
  assert.match(html, /不选目录，也不用点开始监听/);
  assert.match(html, /时间线音轨麦克风/);
  assert.match(html, /画外音录制/);
  assert.match(html, /唯一文件名/);
  assert.match(html, /自动重链接/);
  assert.match(html, /最终保存位置/);
  assert.match(html, /\.prproj 同级的“录音”文件夹/);
  assert.match(html, /只用于发现 Premiere 原始录音，不会改变最终保存位置/);
  assert.match(html, /id="guideProject"/);
  assert.match(html, /id="guideFolder"/);
  assert.match(html, /id="guideListen"/);
});

test('panel preview never presents the capture source as the final save location', async () => {
  const html = await preview.renderIndex('listening', 'rename');
  assert.equal(html.includes('"folderPath":"D:\\\\318最终版\\\\录音"'), true);
  assert.doesNotMatch(html, /Adobe Premiere Pro Captured Audio/);
  assert.match(html, /正在移入工程录音目录并命名/);
});

test('panel puts the real processing result before secondary guidance and connection details', async () => {
  const html = await preview.renderIndex('processing', 'relink');
  const stateIndex = html.indexOf('class="state-band"');
  const pipelineIndex = html.indexOf('class="pipeline-band"');
  const guideIndex = html.indexOf('class="guide-band"');
  const readinessIndex = html.indexOf('class="readiness-band"');

  assert.ok(stateIndex >= 0);
  assert.ok(pipelineIndex > stateIndex);
  assert.ok(guideIndex > pipelineIndex);
  assert.ok(readinessIndex > guideIndex);
  assert.match(html, /链接并改片段/);
});

test('panel owns a definite visible vertical scrollport inside the UXP host', () => {
  assert.match(
    panelStyles,
    /html,\s*body\s*\{[^}]*height:\s*100%;[^}]*min-height:\s*0;[^}]*overflow:\s*hidden;/s,
  );
  assert.match(
    panelStyles,
    /\.app-shell\s*\{[^}]*height:\s*100%;[^}]*min-height:\s*0;[^}]*display:\s*block;[^}]*overflow-x:\s*hidden;[^}]*overflow-y:\s*scroll;/s,
  );
  assert.match(panelStyles, /\.app-shell::\-webkit-scrollbar\s*\{[^}]*width:\s*10px;/s);
  assert.match(panelStyles, /\.app-shell::\-webkit-scrollbar-thumb\s*\{/);
});

test('panel sections stay in document flow instead of shrinking into each other', () => {
  const shellRule = panelStyles.match(/\.app-shell\s*\{([^}]*)\}/s);
  assert.ok(shellRule, 'app shell rule is missing');
  assert.match(shellRule[1], /display:\s*block/);
  assert.doesNotMatch(shellRule[1], /display:\s*flex|flex-direction|flex-shrink/);
});

test('active panel states collapse repeated guidance and readiness details', () => {
  for (const state of ['ready', 'starting', 'listening', 'processing', 'scanning']) {
    assert.match(panelStyles, new RegExp(`\\.app-shell\\[data-panel-state="${state}"\\] \\.guide-steps`));
    assert.match(panelStyles, new RegExp(`\\.app-shell\\[data-panel-state="${state}"\\] \\.readiness-list`));
  }

  for (const state of ['disconnected', 'unsaved', 'no-sequence', 'paused', 'error']) {
    assert.doesNotMatch(panelStyles, new RegExp(`\\.app-shell\\[data-panel-state="${state}"\\] \\.guide-steps`));
    assert.doesNotMatch(panelStyles, new RegExp(`\\.app-shell\\[data-panel-state="${state}"\\] \\.readiness-list`));
  }
});

test('activity history uses the panel scrollport instead of a nested scrollbar', () => {
  assert.match(panelStyles, /\.activity-list\s*\{[^}]*overflow:\s*visible;/s);
  assert.doesNotMatch(panelStyles, /\.activity-list\s*\{[^}]*overflow-y:\s*auto;/s);
  assert.doesNotMatch(panelStyles, /\.activity-list\s*\{[^}]*max-height:/s);
  assert.match(panelMainSource, /var LOG_LIMIT = 20;/);
});

test('production panel uses native controls and the flex/block subset', async () => {
  const html = await preview.renderIndex('listening', 'rename');
  assert.doesNotMatch(html, /<sp-(?:button|checkbox)\b/i);
  assert.match(html, /<button[^>]+id="stopButton"/i);
});

test('panel preview only accepts whitelisted URL state and stage values', () => {
  assert.equal(preview.normalizePreviewState('ready'), 'ready');
  assert.equal(preview.normalizePreviewState('ready<script>'), 'ready');
  assert.equal(preview.normalizePreviewState({ toString: () => 'processing' }), 'ready');
  assert.equal(preview.normalizePreviewStage('rename'), 'rename');
  assert.equal(preview.normalizePreviewStage('save'), 'relink');
  assert.equal(preview.normalizePreviewStage('relink<script>'), 'relink');
});

test('panel preview does not place untrusted query text in an inline script', async () => {
  const attack = '</script><script>globalThis.previewInjected=true</script>';
  const html = await preview.renderIndex(attack, attack);
  assert.doesNotMatch(html, /previewInjected/);
  assert.match(html, /src="src\/panel-state\.js"/);
  assert.doesNotMatch(html, /src="src\/main\.js"/);
});

test('panel preview serves the production state module used by the page', async (t) => {
  const server = preview.startPreviewServer(0);
  await once(server, 'listening');
  t.after(async () => {
    server.close();
    await once(server, 'close');
  });

  const address = server.address();
  const response = await fetch(`http://127.0.0.1:${address.port}/src/panel-state.js`);
  assert.equal(response.status, 200);
  assert.match(await response.text(), /VoiceoverNamerPanelState/);
});
