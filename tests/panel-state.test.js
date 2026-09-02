const test = require('node:test');
const assert = require('node:assert/strict');

const panelState = require('../src/panel-state.js');

const readyContext = {
  hasProject: true,
  projectSaved: true,
  hasSequence: true,
};

test('panel state leads an unconnected user to refresh', () => {
  const result = panelState.derivePanelState({});
  assert.equal(result.mode, 'disconnected');
  assert.equal(result.primaryAction, 'refresh');
  assert.equal(result.readiness.completed, 0);
});

test('panel state distinguishes an unsaved project from no project', () => {
  const result = panelState.derivePanelState({ hasProject: true });
  assert.equal(result.mode, 'unsaved');
  assert.match(result.title, /保存/);
  assert.match(result.description, /项目名/);
  assert.doesNotMatch(result.description, /总序号|录音 ID/);
  assert.equal(result.readiness.project, false);
});

test('a recording folder is no longer a prerequisite for automatic arming', () => {
  const result = panelState.derivePanelState({ hasProject: true, projectSaved: true, hasSequence: true });
  assert.equal(result.mode, 'ready');
  assert.equal(result.primaryAction, 'start');
  assert.equal(result.readiness.completed, 2);
});

test('an unavailable legacy folder does not block automatic discovery', () => {
  const result = panelState.derivePanelState({
    hasProject: true,
    projectSaved: true,
    hasSequence: true,
    hasFolder: false,
    folderSelected: true,
    folderProblem: '旧目录不存在',
  });
  assert.equal(result.mode, 'ready');
  assert.equal(result.primaryAction, 'start');
  assert.equal(result.readiness.completed, 2);
});

test('an active sequence remains the only setup step after saving', () => {
  const result = panelState.derivePanelState({ hasProject: true, projectSaved: true });
  assert.equal(result.mode, 'no-sequence');
  assert.equal(result.readiness.completed, 1);
});

test('ready and listening states expose one clear next action', () => {
  const ready = panelState.derivePanelState(readyContext);
  assert.equal(ready.mode, 'ready');
  assert.equal(ready.primaryAction, 'start');
  assert.equal(ready.readiness.completed, 2);

  const listening = panelState.derivePanelState({ ...readyContext, monitoring: true });
  assert.equal(listening.mode, 'listening');
  assert.equal(listening.primaryAction, '');
  assert.equal(listening.showStop, true);

  const paused = panelState.derivePanelState({ ...readyContext, paused: true });
  assert.equal(paused.mode, 'paused');
  assert.equal(paused.primaryAction, 'resume');
});

test('busy and error states take precedence over the ready state', () => {
  assert.equal(panelState.derivePanelState({ ...readyContext, starting: true }).mode, 'starting');
  assert.equal(panelState.derivePanelState({ ...readyContext, monitoring: true, processing: true }).mode, 'processing');
  assert.equal(panelState.derivePanelState({ ...readyContext, errorMessage: '路径被占用' }).mode, 'error');
  assert.equal(panelState.derivePanelState({ ...readyContext, processing: true, errorMessage: '重链接失败' }).mode, 'error');
});

test('pipeline reports actual active, complete, and failed stages', () => {
  assert.deepEqual(
    panelState.derivePipeline({ stage: 'relink' }).map((entry) => entry.status),
    ['done', 'done', 'done', 'active'],
  );
  assert.deepEqual(
    panelState.derivePipeline({ stage: 'complete' }).map((entry) => entry.status),
    ['done', 'done', 'done', 'done'],
  );
  assert.deepEqual(
    panelState.derivePipeline({ stage: 'error', errorStage: 'rename' }).map((entry) => entry.status),
    ['done', 'done', 'error', 'waiting'],
  );
});

test('pipeline has no project-save stage', () => {
  assert.deepEqual(panelState.PIPELINE_STAGES, ['found', 'stable', 'rename', 'relink']);
  assert.equal(panelState.derivePipeline({ stage: 'save' }).every((entry) => entry.status === 'waiting'), true);
});
