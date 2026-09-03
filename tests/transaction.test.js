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
  const targetName = '项目-7f3c9a2e4b1d48f0a6c1e8d2b9f04a77.wav';
  const trackOriginalNames = options.trackOriginalNames || ['音频 2_1.wav'];
  const trackItems = trackOriginalNames.map((originalName, index) => ({
    name: originalName,
    getNameCalls: 0,
    nameActionCalls: [],
    async getName() {
      this.getNameCalls += 1;
      if (options.trackGetNameError && options.trackGetNameError(this, index, this.getNameCalls)) {
        throw new Error('track name read failed');
      }
      return this.name;
    },
    createSetNameAction(name) {
      this.nameActionCalls.push(name);
      if (options.trackCreateNameActionError && options.trackCreateNameActionError(this, name, index)) {
        throw new Error('track name action failed');
      }
      return () => {
        if (options.transactionResult === false) return true;
        if (options.trackNameAction) return options.trackNameAction(this, name, index);
        this.name = name;
        return true;
      };
    },
  }));
  if (options.missingTrackNameApi) delete trackItems[options.missingTrackNameApiIndex || 0].createSetNameAction;

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
    actionsPerTransaction: [],
    lockedAccess(callback) {
      return callback();
    },
    executeTransaction(callback) {
      this.transactionCount += 1;
      let actionCount = 0;
      const compoundAction = {
        addAction: (action) => {
          actionCount += 1;
          return action();
        },
      };
      try {
        callback(compoundAction);
      } finally {
        this.actionsPerTransaction.push(actionCount);
      }
      return options.transactionResult === undefined ? true : options.transactionResult;
    },
  };
  return { project, item, trackItems, targetName };
}

const paths = {
  source: 'C:\\Captures\\source.wav',
  target: 'C:\\Captures\\renamed.wav',
};

const commonOptions = (fs, premiere, extra = {}) => ({
  fs,
  project: premiere.project,
  projectItem: premiere.item,
  trackItems: premiere.trackItems,
  sourcePath: paths.source,
  targetPath: paths.target,
  targetName: '项目-7f3c9a2e4b1d48f0a6c1e8d2b9f04a77.wav',
  samePath: (left, right) => left.toLowerCase().replaceAll('\\', '/') === right.toLowerCase().replaceAll('\\', '/'),
  delay: async () => {},
  ...extra,
});

const commonNameOptions = (premiere, extra = {}) => ({
  project: premiere.project,
  projectItem: premiere.item,
  trackItems: premiere.trackItems,
  targetName: premiere.targetName,
  expectedMediaPath: paths.source,
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

test('renameAndRelink succeeds and synchronizes the media item and every timeline clip name', async () => {
  const fs = makeFs([paths.source]);
  const premiere = makePremiere({ trackOriginalNames: ['片段甲', '片段乙'] });
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
  assert.deepEqual(premiere.trackItems.map((item) => item.name), [result.targetName, result.targetName]);
  assert.deepEqual(premiere.item.changeCalls, [paths.target]);
  assert.equal(premiere.item.refreshCount, 1);
  assert.equal(premiere.project.transactionCount, 1);
  assert.deepEqual(premiere.project.actionsPerTransaction, [3]);
});

test('missing timeline clips fails closed before disk or Premiere mutation', async () => {
  const fs = makeFs([paths.source]);
  const premiere = makePremiere();

  await assert.rejects(
    transaction.renameAndRelink(commonOptions(fs, premiere, { trackItems: [] })),
    (error) => error.message === '未找到可同步名称的 Premiere 时间线音频片段'
      && error.rollbackWarnings.length === 0,
  );

  assert.deepEqual([...fs.files], [paths.source]);
  assert.deepEqual(fs.renames, []);
  assert.deepEqual(premiere.item.changeCalls, []);
  assert.equal(premiere.project.transactionCount, 0);
});

test('timeline name API failure fails closed before disk or Premiere mutation', async () => {
  const fs = makeFs([paths.source]);
  const premiere = makePremiere({ missingTrackNameApi: true });

  await assert.rejects(
    transaction.renameAndRelink(commonOptions(fs, premiere)),
    (error) => error.message === 'Premiere 时间线片段不支持名称读取或改名 API'
      && error.rollbackWarnings.length === 0,
  );

  assert.deepEqual([...fs.files], [paths.source]);
  assert.deepEqual(fs.renames, []);
  assert.deepEqual(premiere.item.changeCalls, []);
  assert.equal(premiere.project.transactionCount, 0);
});

test('timeline getName exception fails closed before disk or Premiere mutation', async () => {
  const fs = makeFs([paths.source]);
  const premiere = makePremiere({ trackGetNameError: () => true });

  await assert.rejects(
    transaction.renameAndRelink(commonOptions(fs, premiere)),
    (error) => /无法读取 Premiere 时间线片段名称/.test(error.message)
      && error.rollbackWarnings.length === 0,
  );

  assert.deepEqual([...fs.files], [paths.source]);
  assert.deepEqual(fs.renames, []);
  assert.deepEqual(premiere.item.changeCalls, []);
  assert.equal(premiere.project.transactionCount, 0);
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
    (error) => error.message === 'Premiere 素材和时间线片段名称事务返回失败' && error.rollbackWarnings.length === 0,
  );
  assert.equal(fs.files.has(paths.source), true);
  assert.equal(fs.files.has(paths.target), false);
  assert.equal(premiere.item.mediaPath, paths.source);
  assert.equal(premiere.item.name, '原始素材名');
  assert.deepEqual(premiere.item.changeCalls, [paths.target, paths.source]);
});

test('one stale timeline name makes the operation fail and restores every original name', async () => {
  const fs = makeFs([paths.source]);
  const premiere = makePremiere({
    trackOriginalNames: ['片段甲', '片段乙'],
    trackNameAction: (trackItem, name, index) => {
      if (index === 1 && name === '项目-7f3c9a2e4b1d48f0a6c1e8d2b9f04a77.wav') return true;
      trackItem.name = name;
      return true;
    },
  });

  const error = await transaction.renameAndRelink(commonOptions(fs, premiere)).then(
    () => null,
    (caught) => caught,
  );

  assert.equal(error.message, 'Premiere 时间线片段名验证失败');
  assert.deepEqual(error.rollbackWarnings, []);
  assert.equal(fs.files.has(paths.source), true);
  assert.equal(fs.files.has(paths.target), false);
  assert.equal(premiere.item.mediaPath, paths.source);
  assert.equal(premiere.item.name, '原始素材名');
  assert.deepEqual(premiere.trackItems.map((item) => item.name), ['片段甲', '片段乙']);
  assert.deepEqual(premiere.item.changeCalls, [paths.target, paths.source]);
  assert.equal(premiere.project.transactionCount, 2);
  assert.deepEqual(premiere.project.actionsPerTransaction, [3, 3]);
});

test('timeline rename action exception fails the operation and restores partial name changes', async () => {
  const fs = makeFs([paths.source]);
  const premiere = makePremiere({
    trackOriginalNames: ['片段甲', '片段乙'],
    trackCreateNameActionError: (_trackItem, name, index) => index === 1
      && name === '项目-7f3c9a2e4b1d48f0a6c1e8d2b9f04a77.wav',
  });

  const error = await transaction.renameAndRelink(commonOptions(fs, premiere)).then(
    () => null,
    (caught) => caught,
  );

  assert.equal(error.message, '时间线片段改名动作创建失败: track name action failed');
  assert.deepEqual(error.rollbackWarnings, []);
  assert.equal(fs.files.has(paths.source), true);
  assert.equal(fs.files.has(paths.target), false);
  assert.equal(premiere.item.mediaPath, paths.source);
  assert.equal(premiere.item.name, '原始素材名');
  assert.deepEqual(premiere.trackItems.map((item) => item.name), ['片段甲', '片段乙']);
  assert.deepEqual(premiere.project.actionsPerTransaction, [2, 3]);
});

test('rollback does not run a name transaction when neither media path survives', async () => {
  const fs = makeFs([paths.source], {
    afterRename: (source, target, files) => {
      if (source === paths.source && target === paths.target) files.delete(paths.target);
    },
  });
  const premiere = makePremiere({ trackOriginalNames: ['片段甲', '片段乙'] });
  let validationCalls = 0;

  const error = await transaction.renameAndRelink(commonOptions(fs, premiere, {
    validate: async () => {
      validationCalls += 1;
      if (validationCalls === 6) throw new Error('最终上下文验证失败');
      return true;
    },
  })).then(
    () => null,
    (caught) => caught,
  );

  assert.equal(error.message, '最终上下文验证失败');
  assert.ok(error.rollbackWarnings.some((warning) => warning.includes('源文件和目标文件都不存在')));
  assert.equal(fs.files.has(paths.source), false);
  assert.equal(fs.files.has(paths.target), false);
  assert.equal(premiere.project.transactionCount, 1);
  assert.deepEqual(premiere.project.actionsPerTransaction, [3]);
  assert.equal(premiere.item.name, premiere.targetName);
  assert.deepEqual(premiere.trackItems.map((item) => item.name), [premiere.targetName, premiere.targetName]);
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
  assert.equal(error.message, 'Premiere 素材和时间线片段名称事务返回失败');
  assert.ok(error.rollbackWarnings.some((warning) => warning.includes('磁盘文件名回滚失败')));
  assert.ok(error.rollbackWarnings.some((warning) => warning.includes('保留新文件并维持新路径')));
  assert.ok(error.rollbackWarnings.some((warning) => warning.includes('恢复素材名和时间线片段名返回失败')));
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

test('synchronizeNames performs no transaction when the material and every timeline clip already match', async () => {
  const premiere = makePremiere({ trackOriginalNames: ['旧片段甲', '旧片段乙'] });
  premiere.item.name = premiere.targetName;
  premiere.trackItems.forEach((item) => {
    item.name = premiere.targetName;
  });

  const result = await transaction.synchronizeNames(commonNameOptions(premiere));

  assert.deepEqual(result, {
    changed: false,
    targetName: premiere.targetName,
    originalName: premiere.targetName,
  });
  assert.equal(premiere.project.transactionCount, 0);
  assert.deepEqual(premiere.item.changeCalls, []);
  assert.equal(premiere.item.refreshCount, 0);
});

test('synchronizeNames updates the material and every stale timeline clip without relinking media', async () => {
  const premiere = makePremiere({ trackOriginalNames: ['旧片段甲', '旧片段乙'] });

  const result = await transaction.synchronizeNames(commonNameOptions(premiere));

  assert.equal(result.changed, true);
  assert.equal(premiere.item.name, premiere.targetName);
  assert.deepEqual(premiere.trackItems.map((item) => item.name), [premiere.targetName, premiere.targetName]);
  assert.equal(premiere.project.transactionCount, 1);
  assert.deepEqual(premiere.project.actionsPerTransaction, [3]);
  assert.deepEqual(premiere.item.changeCalls, []);
  assert.equal(premiere.item.refreshCount, 0);
});

test('synchronizeNames submits only stale names when the material and one timeline clip already match', async () => {
  const premiere = makePremiere({ trackOriginalNames: ['旧片段', '已同步片段'] });
  premiere.item.name = premiere.targetName;
  premiere.trackItems[1].name = premiere.targetName;

  const result = await transaction.synchronizeNames(commonNameOptions(premiere));

  assert.equal(result.changed, true);
  assert.deepEqual(premiere.trackItems.map((item) => item.name), [premiere.targetName, premiere.targetName]);
  assert.equal(premiere.project.transactionCount, 1);
  assert.deepEqual(premiere.project.actionsPerTransaction, [1]);
  assert.deepEqual(premiere.item.changeCalls, []);
});

test('synchronizeNames fails before mutation when the media path no longer matches the scanned item', async () => {
  const premiere = makePremiere({
    mediaPath: 'C:\\Captures\\other.wav',
    trackOriginalNames: ['旧片段'],
  });

  await assert.rejects(
    transaction.synchronizeNames(commonNameOptions(premiere)),
    (error) => /不再指向待核验的媒体路径/.test(error.message)
      && error.rollbackWarnings.length === 0,
  );

  assert.equal(premiere.item.name, '原始素材名');
  assert.deepEqual(premiere.trackItems.map((item) => item.name), ['旧片段']);
  assert.equal(premiere.project.transactionCount, 0);
  assert.deepEqual(premiere.item.changeCalls, []);
});

test('synchronizeNames fails closed when a timeline clip lacks the name action API', async () => {
  const premiere = makePremiere({
    trackOriginalNames: ['旧片段'],
    missingTrackNameApi: true,
  });

  await assert.rejects(
    transaction.synchronizeNames(commonNameOptions(premiere)),
    (error) => error.message === 'Premiere 时间线片段不支持名称读取或改名 API'
      && error.rollbackWarnings.length === 0,
  );

  assert.equal(premiere.item.name, '原始素材名');
  assert.deepEqual(premiere.trackItems.map((item) => item.name), ['旧片段']);
  assert.equal(premiere.project.transactionCount, 0);
  assert.deepEqual(premiere.item.changeCalls, []);
});

test('synchronizeNames treats a rejected compound transaction as failure without touching media', async () => {
  const premiere = makePremiere({
    trackOriginalNames: ['旧片段'],
    transactionResult: false,
  });

  await assert.rejects(
    transaction.synchronizeNames(commonNameOptions(premiere)),
    (error) => error.message === 'Premiere 素材和时间线片段名称事务返回失败'
      && error.rollbackWarnings.length === 0,
  );

  assert.equal(premiere.item.name, '原始素材名');
  assert.deepEqual(premiere.trackItems.map((item) => item.name), ['旧片段']);
  assert.equal(premiere.project.transactionCount, 1);
  assert.deepEqual(premiere.item.changeCalls, []);
  assert.equal(premiere.item.refreshCount, 0);
});

test('synchronizeNames restores every original name when one timeline clip fails verification', async () => {
  const premiere = makePremiere({
    trackOriginalNames: ['旧片段甲', '旧片段乙'],
    trackNameAction: (trackItem, name, index) => {
      if (index === 1 && name === '项目-7f3c9a2e4b1d48f0a6c1e8d2b9f04a77.wav') return true;
      trackItem.name = name;
      return true;
    },
  });

  const error = await transaction.synchronizeNames(commonNameOptions(premiere)).then(
    () => null,
    (caught) => caught,
  );

  assert.equal(error.message, 'Premiere 时间线片段名验证失败');
  assert.deepEqual(error.rollbackWarnings, []);
  assert.equal(premiere.item.name, '原始素材名');
  assert.deepEqual(premiere.trackItems.map((item) => item.name), ['旧片段甲', '旧片段乙']);
  assert.equal(premiere.project.transactionCount, 2);
  assert.deepEqual(premiere.project.actionsPerTransaction, [3, 2]);
  assert.deepEqual(premiere.item.changeCalls, []);
});

test('synchronizeNames reports an incomplete explicit restore as a rollback warning', async () => {
  const premiere = makePremiere({
    trackOriginalNames: ['旧片段甲', '旧片段乙'],
    trackNameAction: (trackItem, name, index) => {
      if (index === 1 && name === '项目-7f3c9a2e4b1d48f0a6c1e8d2b9f04a77.wav') return true;
      if (index === 0 && name === '旧片段甲') return true;
      trackItem.name = name;
      return true;
    },
  });

  const error = await transaction.synchronizeNames(commonNameOptions(premiere)).then(
    () => null,
    (caught) => caught,
  );

  assert.equal(error.message, 'Premiere 时间线片段名验证失败');
  assert.ok(error.rollbackWarnings.some((warning) => warning.includes('恢复时间线片段名后验证失败')));
  assert.equal(premiere.item.name, '原始素材名');
  assert.equal(premiere.trackItems[0].name, premiere.targetName);
  assert.equal(premiere.trackItems[1].name, '旧片段乙');
  assert.deepEqual(premiere.item.changeCalls, []);
});

test('synchronizeNames restores partial changes when a timeline rename action cannot be created', async () => {
  const premiere = makePremiere({
    trackOriginalNames: ['旧片段甲', '旧片段乙'],
    trackCreateNameActionError: (_trackItem, name, index) => index === 1
      && name === '项目-7f3c9a2e4b1d48f0a6c1e8d2b9f04a77.wav',
  });

  const error = await transaction.synchronizeNames(commonNameOptions(premiere)).then(
    () => null,
    (caught) => caught,
  );

  assert.equal(error.message, '时间线片段改名动作创建失败: track name action failed');
  assert.deepEqual(error.rollbackWarnings, []);
  assert.equal(premiere.item.name, '原始素材名');
  assert.deepEqual(premiere.trackItems.map((item) => item.name), ['旧片段甲', '旧片段乙']);
  assert.deepEqual(premiere.project.actionsPerTransaction, [2, 2]);
  assert.deepEqual(premiere.item.changeCalls, []);
});

test('synchronizeNames preserves cancellation and restores names after a context switch', async () => {
  const premiere = makePremiere({ trackOriginalNames: ['旧片段'] });
  let validationCalls = 0;

  const error = await transaction.synchronizeNames(commonNameOptions(premiere, {
    validate: async () => {
      validationCalls += 1;
      if (validationCalls === 3) {
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
  assert.equal(premiere.item.name, '原始素材名');
  assert.deepEqual(premiere.trackItems.map((item) => item.name), ['旧片段']);
  assert.equal(premiere.project.transactionCount, 2);
  assert.deepEqual(premiere.item.changeCalls, []);
});

test('setProjectItemName uses a locked Premiere transaction and returns its result', () => {
  const premiere = makePremiere();
  assert.equal(transaction.setProjectItemName(
    premiere.project, premiere.item, '新名字', '测试事务',
  ), true);
  assert.equal(premiere.item.name, '新名字');
  assert.equal(premiere.project.transactionCount, 1);
});
