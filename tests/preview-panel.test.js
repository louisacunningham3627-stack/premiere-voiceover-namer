const test = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');

const panelState = require('../src/panel-state.js');

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
  assert.match(html, /id="guideProject"/);
  assert.match(html, /id="guideFolder"/);
  assert.match(html, /id="guideListen"/);
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
