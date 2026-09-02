const test = require('node:test');
const assert = require('node:assert/strict');

const transaction = require('../src/transaction.js');

function makeFs(initialPaths, options = {}) {
  const files = new Set(initialPaths);
  const renames = [];
  return {
    files,
    renames,
    async lstat(path) {
      if (!files.has(path)) throw new Error('missing: ' + path);
      return { path };
    },
    async rename(source, target) {
      renames.push([source, target]);
      if (options.renameError && options.renameError(source, target)) throw new Error('rename failed');
      if (options.renameResult !== undefined) return options.renameResult;
      if (!files.has(source)) throw new Error('missing source');
      if (files.has(target)) throw new Error('target exists');
      files.delete(source);
      files.add(target);
      if (options.afterRename) options.afterRename(source, target, files);
      return 0;
    },
  };
}

function makePremiere(options = {}) {
  const item = {
    name: options.originalName || '原始素材名',
    mediaPath: options.mediaPath || 'C:\\Captures\\source.wav',
    changeCalls: [],
    refreshCount: 0,
    async canChangeMediaPath() {
      return options.canChange !== false;
    },
    async changeMediaFilePath(path) {
      this.changeCalls.push(path);
      if (options.changeError && options.changeError(path, this.changeCalls.length)) throw new Error('relink failed');
      if (options.changeResult && options.changeResult(path, this.changeCalls.length) === false) return false;
      this.mediaPath = path;
      return true;
    },
    async refreshMedia() {
      this.refreshCount += 1;
    },
    async getMediaFilePath() {
      return this.mediaPath;
    },
    async isOffline() {
      return options.offline === true;
    },
    createSetNameAction(name) {
      return () => {
        if (options.transactionResult === false) return true;
        if (options.nameAction) return options.nameAction(this, name);
        this.name = name;
        return true;
      };
    },
  };
  const project = {
    transactionCount: 0,
    lockedAccess(callback) {
      return callback();
    },
    executeTransaction(callback) {
      this.transactionCount += 1;
      const compoundAction = { addAction: (action) => action() };
      callback(compoundAction);
      return options.transactionResult === undefined ? true : options.transactionResult;
    },
  };
  return { project, item };
}

const paths = {
  source: 'C:\\Captures\\source.wav',
  target: 'C:\\Captures\\renamed.wav',
};

const commonOptions = (fs, premiere, extra = {}) => ({
  fs,
  project: premiere.project,
  projectItem: premiere.item,
  sourcePath: paths.source,
  targetPath: paths.target,
  targetName: '项目-7f3c9a2e4b1d48f0a6c1e8d2b9f04a77.wav',
  samePath: (left, right) => left.toLowerCase().replaceAll('\\', '/') === right.toLowerCase().replaceAll('\\', '/'),
  delay: async () => {},
  ...extra,
});

test('exists reports filesystem presence without leaking lstat errors', async () => {
  const fs = makeFs(['present.wav']);
  assert.equal(await transaction.exists(fs, 'present.wav'), true);
  assert.equal(await transaction.exists(fs, 'missing.wav'), false);
});

test('target conflict detection recognizes direct and wrapped filesystem errors', () => {
  assert.equal(transaction.isTargetConflict(new Error('目标文件已存在')), true);
  assert.equal(transaction.isTargetConflict(Object.assign(new Error('rename failed'), { code: 'EEXIST' })), true);
  assert.equal(transaction.isTargetConflict(new Error('File already exists')), true);
  assert.equal(transaction.isTargetConflict(Object.assign(new Error('wrapped'), {
    cause: Object.assign(new Error('native failure'), { code: 'EEXIST' }),
  })), true);
  assert.equal(transaction.isTargetConflict(Object.assign(new Error('locked'), { code: 'EBUSY' })), false);
});

test('renameAndRelink succeeds and synchronizes the media item name', async () => {
  const fs = makeFs([paths.source]);
  const premiere = makePremiere();
  const result = await transaction.renameAndRelink(commonOptions(fs, premiere));
  assert.deepEqual(result, {
    sourcePath: paths.source,
    targetPath: paths.target,
    targetName: '项目-7f3c9a2e4b1d48f0a6c1e8d2b9f04a77.wav',
    originalName: '原始素材名',
  });
  assert.equal(fs.files.has(paths.source), false);
  assert.equal(fs.files.has(paths.target), true);
  assert.equal(premiere.item.mediaPath, paths.target);
  assert.equal(premiere.item.name, result.targetName);
  assert.deepEqual(premiere.item.changeCalls, [paths.target]);
  assert.equal(premiere.item.refreshCount, 1);
  assert.equal(premiere.project.transactionCount, 1);
});

test('renameAndRelink never invokes legacy project persistence hooks', async () => {
  const fs = makeFs([paths.source]);
  const premiere = makePremiere();
  let persistCalls = 0;
  let persistRollbackCalls = 0;

  await transaction.renameAndRelink(commonOptions(fs, premiere, {
    persist: async () => {
      persistCalls += 1;
      throw new Error('must not save');
    },
    persistRollback: async () => {
      persistRollbackCalls += 1;
      throw new Error('must not save rollback');
    },
  }));

  assert.equal(persistCalls, 0);
  assert.equal(persistRollbackCalls, 0);
});

test('renameAndRelink reports only the rename and relink hot-path stages', async () => {
  const fs = makeFs([paths.source]);
  const premiere = makePremiere();
  const stages = [];

  await transaction.renameAndRelink(commonOptions(fs, premiere, {
    onStage: (stage) => stages.push(stage),
  }));

  assert.deepEqual(stages, ['rename', 'relink']);
});

test('a context switch after disk rename rolls back before Premiere is relinked', async () => {
  const fs = makeFs([paths.source]);
  const premiere = makePremiere();
  let validationCalls = 0;

  const error = await transaction.renameAndRelink(commonOptions(fs, premiere, {
    validate: async () => {
      validationCalls += 1;
      if (validationCalls === 3) {
        const switched = new Error('项目已切换');
        switched.code = 'VOICEOVER_NAMER_CANCELLED';
        throw switched;
      }
      return true;
    },
  })).then(
    () => null,
    (caught) => caught,
  );

  assert.equal(error.code, 'VOICEOVER_NAMER_CANCELLED');
  assert.equal(validationCalls, 3);
  assert.equal(fs.files.has(paths.source), true);
  assert.equal(fs.files.has(paths.target), false);
  assert.equal(premiere.item.mediaPath, paths.source);
  assert.equal(premiere.item.name, '原始素材名');
  assert.deepEqual(premiere.item.changeCalls, []);
});

test('a context switch after the item rename rolls back the completed hot path', async () => {
  const fs = makeFs([paths.source]);
  const premiere = makePremiere();
  let validationCalls = 0;

  const error = await transaction.renameAndRelink(commonOptions(fs, premiere, {
    validate: async () => {
      validationCalls += 1;
      if (validationCalls === 6) {
        const switched = new Error('序列已切换');
        switched.code = 'VOICEOVER_NAMER_CANCELLED';
        throw switched;
      }
      return true;
    },
  })).then(
    () => null,
    (caught) => caught,
  );

  assert.equal(error.code, 'VOICEOVER_NAMER_CANCELLED');
  assert.equal(validationCalls, 6);
  assert.equal(fs.files.has(paths.source), true);
  assert.equal(fs.files.has(paths.target), false);
  assert.equal(premiere.item.mediaPath, paths.source);
  assert.equal(premiere.item.name, '原始素材名');
});

test('target conflict fails before mutating disk or Premiere', async () => {
  const fs = makeFs([paths.source, paths.target]);
  const premiere = makePremiere();
  await assert.rejects(
    transaction.renameAndRelink(commonOptions(fs, premiere)),
    (error) => error.message === '目标文件已存在' && error.rollbackWarnings.length === 0,
  );
  assert.deepEqual([...fs.files].sort(), [paths.source, paths.target].sort());
  assert.deepEqual(premiere.item.changeCalls, []);
  assert.equal(premiere.project.transactionCount, 0);
});

test('a changed ProjectItem source path fails before disk rename with zero mutation', async () => {
  const fs = makeFs([paths.source]);
  const otherPath = 'C:\\Captures\\different-source.wav';
  const premiere = makePremiere({ mediaPath: otherPath });

  await assert.rejects(
    transaction.renameAndRelink(commonOptions(fs, premiere)),
    (error) => error.rollbackWarnings.length === 0
      && /源|媒体|候选|路径/.test(error.message),
  );

  assert.deepEqual([...fs.files], [paths.source]);
  assert.deepEqual(fs.renames, []);
  assert.equal(premiere.item.mediaPath, otherPath);
  assert.equal(premiere.item.name, '原始素材名');
  assert.deepEqual(premiere.item.changeCalls, []);
  assert.equal(premiere.project.transactionCount, 0);
});

test('relink failure restores the original filename and media path', async () => {
  const fs = makeFs([paths.source]);
  const premiere = makePremiere({
    changeResult: (path) => path !== paths.target,
  });
  await assert.rejects(
    transaction.renameAndRelink(commonOptions(fs, premiere)),
    (error) => error.message === 'Premiere 重链接返回失败' && error.rollbackWarnings.length === 0,
  );
  assert.equal(fs.files.has(paths.source), true);
  assert.equal(fs.files.has(paths.target), false);
  assert.equal(premiere.item.mediaPath, paths.source);
  assert.deepEqual(premiere.item.changeCalls, [paths.target]);
  assert.equal(premiere.item.refreshCount, 0);
});

test('material-name transaction failure rolls back file and media link', async () => {
  const fs = makeFs([paths.source]);
  const premiere = makePremiere({ transactionResult: false });
  await assert.rejects(
    transaction.renameAndRelink(commonOptions(fs, premiere)),
    (error) => error.message === 'Premiere 素材名事务返回失败' && error.rollbackWarnings.length === 0,
  );
  assert.equal(fs.files.has(paths.source), true);
  assert.equal(fs.files.has(paths.target), false);
  assert.equal(premiere.item.mediaPath, paths.source);
  assert.equal(premiere.item.name, '原始素材名');
  assert.deepEqual(premiere.item.changeCalls, [paths.target, paths.source]);
});

test('offline or mismatched relink verification rolls back', async () => {
  const fs = makeFs([paths.source]);
  const premiere = makePremiere({ offline: true });
  await assert.rejects(
    transaction.renameAndRelink(commonOptions(fs, premiere)),
    (error) => error.message === '重链接后素材仍离线或路径不一致'
      && error.rollbackWarnings.some((warning) => warning.includes('恢复媒体路径后验证失败')),
  );
  assert.equal(fs.files.has(paths.source), true);
  assert.equal(fs.files.has(paths.target), false);
});

test('failed disk rollback keeps Premiere on the existing target instead of a missing source', async () => {
  const fs = makeFs([paths.source], {
    renameError: (source, target) => source === paths.target && target === paths.source,
  });
  const premiere = makePremiere({
    transactionResult: false,
    changeResult: (path) => path !== paths.source,
  });
  const error = await transaction.renameAndRelink(commonOptions(fs, premiere)).then(
    () => null,
    (caught) => caught,
  );
  assert.equal(error.message, 'Premiere 素材名事务返回失败');
  assert.ok(error.rollbackWarnings.some((warning) => warning.includes('磁盘文件名回滚失败')));
  assert.ok(error.rollbackWarnings.some((warning) => warning.includes('保留新文件并维持新路径')));
  assert.ok(error.rollbackWarnings.some((warning) => warning.includes('恢复素材名返回失败')));
  assert.equal(fs.files.has(paths.target), true);
  assert.equal(fs.files.has(paths.source), false);
  assert.equal(premiere.item.mediaPath, paths.target);
  assert.deepEqual(premiere.item.changeCalls, [paths.target]);
});

test('failed file rollback recovers a failed forward relink to the surviving target', async () => {
  const fs = makeFs([paths.source], {
    renameError: (source, target) => source === paths.target && target === paths.source,
  });
  const premiere = makePremiere({
    changeResult: (path, callCount) => !(path === paths.target && callCount === 1),
  });
  const error = await transaction.renameAndRelink(commonOptions(fs, premiere)).then(
    () => null,
    (caught) => caught,
  );
  assert.equal(error.message, 'Premiere 重链接返回失败');
  assert.ok(error.rollbackWarnings.some((warning) => warning.includes('磁盘文件名回滚失败')));
  assert.ok(error.rollbackWarnings.some((warning) => warning.includes('保留新文件并维持新路径')));
  assert.equal(fs.files.has(paths.target), true);
  assert.equal(fs.files.has(paths.source), false);
  assert.equal(premiere.item.mediaPath, paths.target);
  assert.equal(premiere.item.name, '项目-7f3c9a2e4b1d48f0a6c1e8d2b9f04a77.wav');
  assert.deepEqual(premiere.item.changeCalls, [paths.target, paths.target]);
});

test('rollback keeps the transaction target when an external file recreates the source path', async () => {
  const fs = makeFs([paths.source], {
    afterRename: (source, target, files) => {
      if (source === paths.source && target === paths.target) files.add(paths.source);
    },
  });
  const premiere = makePremiere({
    changeResult: (path, callCount) => !(path === paths.target && callCount === 1),
  });

  const error = await transaction.renameAndRelink(commonOptions(fs, premiere)).then(
    () => null,
    (caught) => caught,
  );

  assert.equal(error.message, 'Premiere 重链接返回失败');
  assert.ok(error.rollbackWarnings.some((warning) => warning.includes('旧路径与新路径同时存在')));
  assert.ok(error.rollbackWarnings.some((warning) => warning.includes('保留新文件并维持新路径')));
  assert.equal(fs.files.has(paths.source), true);
  assert.equal(fs.files.has(paths.target), true);
  assert.equal(premiere.item.mediaPath, paths.target);
  assert.equal(premiere.item.name, '项目-7f3c9a2e4b1d48f0a6c1e8d2b9f04a77.wav');
  assert.deepEqual(premiere.item.changeCalls, [paths.target, paths.target]);
});

test('setProjectItemName uses a locked Premiere transaction and returns its result', () => {
  const premiere = makePremiere();
  assert.equal(transaction.setProjectItemName(
    premiere.project, premiere.item, '新名字', '测试事务',
  ), true);
  assert.equal(premiere.item.name, '新名字');
  assert.equal(premiere.project.transactionCount, 1);
});
