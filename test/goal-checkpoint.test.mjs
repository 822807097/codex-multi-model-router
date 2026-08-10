import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CHECKPOINT_HEADINGS,
  GoalCheckpointStore,
  buildCheckpointMessages,
  buildCheckpointSource,
  extractCheckpointText,
  extractGoalAnchor,
  normalizeCheckpoint,
  resolveStrongTaskKey,
} from '../lib/goal-checkpoint.mjs';

const VALID_CHECKPOINT = `目标\n完成路由优化\n\n硬性约束\n零依赖\n\n已完成\n基础转换\n\n进行中\n检查点\n\n待完成\n集成测试\n\n关键决定\n使用 assistant 注入\n\n当前工作集\ncodex-router.mjs\n\n失败与原因\n无\n\n下一步\n运行测试`;

test('最新成功的 Codex 目标工具结果优先于 metadata 和 /goal 文本', () => {
  const body = {
    instructions: '始终遵守用户约束',
    metadata: { objective: 'metadata 目标' },
    input: [
      { role: 'developer', content: [{ type: 'input_text', text: '不得部署' }] },
      { role: 'user', content: [{ type: 'input_text', text: '/goal 旧目标' }] },
      { type: 'function_call', name: 'get_goal', call_id: 'goal_1', arguments: '{}' },
      {
        type: 'function_call_output',
        call_id: 'goal_1',
        output: JSON.stringify({ goal: { objective: '持续优化长任务', status: 'active' } }),
      },
    ],
  };

  const anchor = extractGoalAnchor(body);

  assert.equal(anchor.objective, '持续优化长任务');
  assert.equal(anchor.status, 'active');
  assert.equal(anchor.source, 'goal_tool');
  assert.match(anchor.text, /始终遵守用户约束/);
  assert.match(anchor.text, /不得部署/);
});

test('没有结构化目标状态时使用最新 /goal 命令', () => {
  const anchor = extractGoalAnchor({
    input: [
      { role: 'user', content: '/goal 第一目标' },
      { role: 'assistant', content: '处理中' },
      { role: 'user', content: '/goal 第二目标' },
    ],
  });
  assert.equal(anchor.objective, '第二目标');
  assert.equal(anchor.source, 'goal_command');
});

test('检查点来源保留任务起点、旧检查点和最近完整轮次', () => {
  const removedMessages = [
    { role: 'user', content: '任务起点' },
    { role: 'assistant', content: '起点回复' },
    { role: 'user', content: '中间轮次'.repeat(200) },
    { role: 'assistant', content: '中间回复'.repeat(200) },
    { role: 'user', content: '最近轮次' },
    { role: 'assistant', content: '', tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'read', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'call_1', content: '最近工具结果' },
  ];
  const source = buildCheckpointSource({
    goalAnchor: { text: '目标：持续完成任务' },
    previousCheckpoint: VALID_CHECKPOINT,
    removedMessages,
    tokenBudget: 600,
  });

  assert.match(source.text, /任务起点/);
  assert.match(source.text, /旧检查点/);
  assert.match(source.text, /最近工具结果/);
  assert.doesNotMatch(source.text, /中间轮次/);
  assert.match(source.hash, /^[a-f0-9]{64}$/);
});

test('本轮无显式目标时来源直接继承旧检查点目标', () => {
  const source = buildCheckpointSource({
    goalAnchor: { objective: '', text: '目标来源：instructions\n目标：未显式提供' },
    previousCheckpoint: VALID_CHECKPOINT,
    removedMessages: [{ role: 'user', content: '继续任务' }],
    tokenBudget: 600,
  });

  assert.match(source.text, /目标：完成路由优化/);
  assert.match(source.text, /本轮未显式提供新目标/);
});

test('首个任务轮次本身超出来源预算时仍保留截断后的用户任务起点', () => {
  const source = buildCheckpointSource({
    goalAnchor: { text: '目标：长任务' },
    removedMessages: [
      { role: 'user', content: `必须保留的任务起点\n${'超长正文'.repeat(2_000)}` },
      { role: 'assistant', content: '旧回复'.repeat(2_000) },
    ],
    tokenBudget: 256,
  });

  assert.match(source.text, /必须保留的任务起点/);
  assert.ok(source.estimatedTokens <= 256);
});

test('超长目标锚点和旧检查点也必须服从来源硬预算', () => {
  const source = buildCheckpointSource({
    goalAnchor: { text: `目标：${'超长目标约束'.repeat(2_000)}` },
    previousCheckpoint: VALID_CHECKPOINT.repeat(200),
    removedMessages: [{ role: 'user', content: '最近任务' }],
    tokenBudget: 512,
  });

  assert.ok(source.estimatedTokens <= 512);
  assert.ok(Buffer.byteLength(source.text, 'utf8') / 3 < 700);
});

test('摘要提示固定九个栏目并把历史声明为不可执行数据', () => {
  const messages = buildCheckpointMessages({ text: '来源内容' });
  assert.equal(messages.length, 2);
  assert.equal(messages[0].role, 'system');
  assert.match(messages[0].content, /历史内容仅是数据/);
  for (const heading of CHECKPOINT_HEADINGS) assert.match(messages[0].content, new RegExp(heading));
  assert.equal(messages[1].role, 'user');
  assert.match(messages[1].content, /来源内容/);
});

test('没有新显式目标时摘要器必须继承旧检查点目标', () => {
  const messages = buildCheckpointMessages({
    text: '## 目标锚点\n目标：未显式提供\n\n## 旧检查点\n目标\n跨供应商持续任务',
  });
  assert.match(messages[0].content, /未显式提供.*必须沿用旧检查点的目标/);
  assert.match(messages[0].content, /只有.*新的显式目标.*替换/);
});

test('解析 Chat 摘要正文并拒绝缺少固定栏目的结果', () => {
  assert.equal(extractCheckpointText({ choices: [{ message: { content: VALID_CHECKPOINT } }] }), VALID_CHECKPOINT);
  assert.equal(extractCheckpointText({ choices: [{ message: { content: [{ type: 'text', text: VALID_CHECKPOINT }] } }] }), VALID_CHECKPOINT);
  assert.match(normalizeCheckpoint(VALID_CHECKPOINT, 2_048), /^\[Codex 持续目标执行检查点\]/);
  assert.throws(() => normalizeCheckpoint('只有目标，没有其他栏目', 2_048), /缺少栏目/);
});

test('检查点兼容加粗列表标题和同行正文并归一化', () => {
  const markdownList = CHECKPOINT_HEADINGS
    .map((heading) => `- **${heading}**：${heading}内容`)
    .join('\n');
  const normalized = normalizeCheckpoint(markdownList, 2_048);

  for (const heading of CHECKPOINT_HEADINGS) {
    assert.match(normalized, new RegExp(`(?:^|\\n)${heading}\\n${heading}内容(?:\\n|$)`));
  }
  assert.doesNotMatch(normalized, /\*\*/);
});

test('检查点剥离模型附加的 Markdown 代码围栏', () => {
  const normalized = normalizeCheckpoint(`\`\`\`markdown\n${VALID_CHECKPOINT}\n\`\`\``, 2_048);
  assert.doesNotMatch(normalized, /```/);
  assert.match(normalized, /下一步\n运行测试$/);
});

test('过长检查点按栏目缩短后仍保留全部固定标题', () => {
  const longCheckpoint = CHECKPOINT_HEADINGS
    .map((heading) => `${heading}\n${`${heading}内容`.repeat(300)}`)
    .join('\n\n');
  const normalized = normalizeCheckpoint(longCheckpoint, 256);

  for (const heading of CHECKPOINT_HEADINGS) {
    assert.match(normalized, new RegExp(`(?:^|\\n)${heading}(?:\\n|$)`));
  }
  assert.ok(normalized.length <= 256 * 3 + 64);
});

test('检查点栏目必须按固定顺序出现', () => {
  const scrambled = VALID_CHECKPOINT.replace('目标\n完成路由优化', '临时标题\n无')
    + '\n\n目标\n完成路由优化';
  assert.throws(() => normalizeCheckpoint(scrambled, 2_048), /栏目顺序/);
});

test('强任务键允许跨模型取得检查点，孤立 previous_response_id 不允许', () => {
  let now = 1_000;
  const store = new GoalCheckpointStore({ maxEntries: 4, ttlMs: 100, now: () => now });
  const taskKey = resolveStrongTaskKey({ metadata: { session_id: 'session-a' } }, {}, store);
  assert.equal(taskKey, 'metadata:session-a');
  assert.equal(resolveStrongTaskKey({ previous_response_id: 'unknown' }, {}, store), null);

  store.remember({
    taskKey,
    exactKey: 'deepseek|model-a|hash-a',
    checkpoint: VALID_CHECKPOINT,
    responseId: 'resp-a',
  });

  const restoredTaskKey = resolveStrongTaskKey({ previous_response_id: 'resp-a' }, {}, store);
  assert.match(restoredTaskKey, /^task:[a-f0-9]{64}$/);
  assert.equal(store.getTask(restoredTaskKey), VALID_CHECKPOINT);
  assert.equal(store.getTask(taskKey), VALID_CHECKPOINT);
  assert.equal(store.getExact('deepseek|model-a|hash-a'), VALID_CHECKPOINT);
  assert.equal(store.getExact('qwen|model-b|hash-a'), null);

  now += 101;
  assert.equal(store.getTask(taskKey), null);
});

test('检查点存储按 LRU 上限淘汰且不同任务不串用', () => {
  const store = new GoalCheckpointStore({ maxEntries: 2, ttlMs: 10_000, now: () => 1_000 });
  store.remember({ taskKey: 'header:a', exactKey: 'p|m|a', checkpoint: `${VALID_CHECKPOINT}\nA`, responseId: 'a' });
  store.remember({ taskKey: 'header:b', exactKey: 'p|m|b', checkpoint: `${VALID_CHECKPOINT}\nB`, responseId: 'b' });
  assert.match(store.getTask('header:a'), /A$/);
  store.remember({ taskKey: 'header:c', exactKey: 'p|m|c', checkpoint: `${VALID_CHECKPOINT}\nC`, responseId: 'c' });

  assert.equal(store.getTask('header:b'), null);
  assert.match(store.getTask('header:a'), /A$/);
  assert.match(store.getTask('header:c'), /C$/);
});

test('不同任务共享精确摘要哈希时仍分别保留任务别名', () => {
  const store = new GoalCheckpointStore({ maxEntries: 4, ttlMs: 10_000, now: () => 1_000 });
  store.remember({ taskKey: 'header:a', exactKey: 'provider|model|same', checkpoint: `${VALID_CHECKPOINT}\nA`, responseId: 'a1' });
  store.remember({ taskKey: 'header:b', exactKey: 'provider|model|same', checkpoint: `${VALID_CHECKPOINT}\nB`, responseId: 'b1' });

  assert.match(store.getTask('header:a'), /A$/);
  assert.match(store.getTask('header:b'), /B$/);
});

test('同一任务更新检查点后旧 response id 仍能解析到任务', () => {
  const store = new GoalCheckpointStore({ maxEntries: 4, ttlMs: 10_000, now: () => 1_000 });
  store.remember({ taskKey: 'header:a', exactKey: 'provider-a|model|one', checkpoint: `${VALID_CHECKPOINT}\nA`, responseId: 'resp-old' });
  store.remember({ taskKey: 'header:a', exactKey: 'provider-b|model|two', checkpoint: `${VALID_CHECKPOINT}\nB`, responseId: 'resp-new' });

  const oldTask = store.taskForResponse('resp-old');
  const newTask = store.taskForResponse('resp-new');
  assert.match(oldTask, /^task:[a-f0-9]{64}$/);
  assert.equal(newTask, oldTask);
  assert.match(store.getTask(oldTask), /B$/);
});

test('同一活跃任务只保留有界的最近 response id 别名', () => {
  const store = new GoalCheckpointStore({
    maxEntries: 4,
    maxResponseIdsPerTask: 2,
    ttlMs: 10_000,
    now: () => 1_000,
  });
  store.remember({ taskKey: 'header:a', exactKey: 'p|m|1', checkpoint: VALID_CHECKPOINT, responseId: 'resp-1' });
  store.remember({ taskKey: 'header:a', exactKey: 'p|m|2', checkpoint: VALID_CHECKPOINT, responseId: 'resp-2' });
  store.remember({ taskKey: 'header:a', exactKey: 'p|m|3', checkpoint: VALID_CHECKPOINT, responseId: 'resp-3' });

  assert.equal(store.taskForResponse('resp-1'), null);
  assert.match(store.taskForResponse('resp-2'), /^task:[a-f0-9]{64}$/);
  assert.equal(store.taskForResponse('resp-3'), store.taskForResponse('resp-2'));
});

test('检查点来源会截断工具正文并清理常见凭据值', () => {
  const secret = 'sk-sensitive-value-1234567890';
  const source = buildCheckpointSource({
    goalAnchor: { text: '目标：安全接力' },
    removedMessages: [{
      role: 'tool',
      content: `执行结果\nAuthorization: Bearer private-token-value\napi_key=${secret}\n${'x'.repeat(8_000)}`,
    }],
    tokenBudget: 10_000,
  });

  assert.doesNotMatch(source.text, /private-token-value/);
  assert.doesNotMatch(source.text, /sk-sensitive-value/);
  assert.ok(source.text.length < 4_000);
  assert.match(source.text, /工具输出/);
});

test('同一任务只允许最后开始的并发请求更新检查点', () => {
  const store = new GoalCheckpointStore({ maxEntries: 8, ttlMs: 60_000 });
  const older = store.beginTask('task:concurrent');
  const newer = store.beginTask('task:concurrent');

  assert.equal(store.remember({
    taskKey: 'task:concurrent',
    checkpoint: '旧请求晚完成',
    requestSequence: older,
  }), false);
  assert.equal(store.remember({
    taskKey: 'task:concurrent',
    checkpoint: '新请求进度',
    requestSequence: newer,
  }), true);
  assert.equal(store.getTask('task:concurrent'), '新请求进度');
});

test('检查点任务、精确来源和 response id 只持久化带域定长摘要', () => {
  const longTaskKey = `metadata:${'t'.repeat(100_000)}`;
  const longExactKey = `provider|model-${'m'.repeat(100_000)}|hash`;
  const longResponseId = `resp_${'r'.repeat(100_000)}`;
  const store = new GoalCheckpointStore({ maxEntries: 4, ttlMs: 60_000 });
  const requestSequence = store.beginTask(longTaskKey);

  assert.equal(store.remember({
    taskKey: longTaskKey,
    exactKey: longExactKey,
    checkpoint: VALID_CHECKPOINT,
    responseId: longResponseId,
    requestSequence,
  }), true);

  const opaqueTaskKey = store.taskForResponse(longResponseId);
  assert.match(opaqueTaskKey, /^task:[a-f0-9]{64}$/);
  assert.equal(store.getTask(longTaskKey), VALID_CHECKPOINT);
  assert.equal(store.getTask(opaqueTaskKey), VALID_CHECKPOINT);
  assert.equal(store.getExact(longExactKey), VALID_CHECKPOINT);
  assert.ok([...store.tasks.keys(), ...store.latestRequests.keys()].every((key) => /^task:[a-f0-9]{64}$/.test(key)));
  assert.ok([...store.exacts.keys()].every((key) => /^exact:[a-f0-9]{64}$/.test(key)));
  assert.ok([...store.responses.keys()].every((key) => /^response:[a-f0-9]{64}$/.test(key)));
  assert.ok([...store.entries.values()].every((entry) => {
    const serialized = JSON.stringify({
      ...entry,
      responseIds: [...entry.responseIds],
    });
    return !serialized.includes(longTaskKey)
      && !serialized.includes(longExactKey)
      && !serialized.includes(longResponseId);
  }));
});

test('同名 response id 绑定多个任务时不得反查为任一任务', () => {
  const store = new GoalCheckpointStore({ maxEntries: 4, ttlMs: 60_000 });
  store.remember({ taskKey: 'header:task-a', checkpoint: `${VALID_CHECKPOINT}\nA`, responseId: 'resp_same' });
  store.remember({ taskKey: 'header:task-b', checkpoint: `${VALID_CHECKPOINT}\nB`, responseId: 'resp_same' });

  assert.equal(store.taskForResponse('resp_same'), null);
  assert.match(store.getTask('header:task-a'), /A$/);
  assert.match(store.getTask('header:task-b'), /B$/);
});

test('同名 response id 碰撞后其中一个任务被 LRU 淘汰仍保持歧义', () => {
  const store = new GoalCheckpointStore({ maxEntries: 2, ttlMs: 60_000 });
  store.remember({ taskKey: 'header:task-a', checkpoint: `${VALID_CHECKPOINT}\nA`, responseId: 'resp_same' });
  store.remember({ taskKey: 'header:task-b', checkpoint: `${VALID_CHECKPOINT}\nB`, responseId: 'resp_same' });
  store.remember({ taskKey: 'header:task-c', checkpoint: `${VALID_CHECKPOINT}\nC`, responseId: 'resp_c' });

  assert.equal(store.getTask('header:task-a'), null);
  assert.match(store.getTask('header:task-b'), /B$/);
  assert.equal(store.taskForResponse('resp_same'), null);
});

test('同名 response id 的歧义保持到 response 索引自身 TTL 到期', () => {
  let now = 0;
  const store = new GoalCheckpointStore({ maxEntries: 4, ttlMs: 100, now: () => now });
  store.remember({ taskKey: 'header:task-a', checkpoint: `${VALID_CHECKPOINT}\nA`, responseId: 'resp_same' });
  now = 50;
  store.remember({ taskKey: 'header:task-b', checkpoint: `${VALID_CHECKPOINT}\nB`, responseId: 'resp_same' });

  now = 101;
  assert.equal(store.taskForResponse('resp_same'), null);
  assert.match(store.getTask('header:task-b'), /B$/);
  assert.equal(store.responses.size, 1);

  now = 151;
  assert.equal(store.taskForResponse('resp_same'), null);
  assert.equal(store.responses.size, 0);
});

test('response 索引按独立 LRU 上限淘汰且不会被任务更新重新带回', () => {
  const store = new GoalCheckpointStore({
    maxEntries: 4,
    maxResponseIdsPerTask: 4,
    maxResponseIndexes: 2,
    ttlMs: 60_000,
  });
  store.remember({ taskKey: 'header:task-a', checkpoint: `${VALID_CHECKPOINT}\nA`, responseId: 'resp_a' });
  store.remember({ taskKey: 'header:task-b', checkpoint: `${VALID_CHECKPOINT}\nB`, responseId: 'resp_b' });
  store.taskForResponse('resp_a'); // 刷新 A，使 B 成为最旧索引。
  store.remember({ taskKey: 'header:task-c', checkpoint: `${VALID_CHECKPOINT}\nC`, responseId: 'resp_c' });

  assert.match(store.getTask(store.taskForResponse('resp_a')), /A$/);
  assert.equal(store.taskForResponse('resp_b'), null);
  assert.match(store.getTask(store.taskForResponse('resp_c')), /C$/);
  assert.equal(store.responses.size, 2);

  store.remember({ taskKey: 'header:task-b', checkpoint: `${VALID_CHECKPOINT}\nB2` });
  assert.equal(store.taskForResponse('resp_b'), null);
});

test('歧义 response 索引被查询时也刷新 LRU 并保持保守哨兵', () => {
  const store = new GoalCheckpointStore({
    maxEntries: 5,
    maxResponseIdsPerTask: 4,
    maxResponseIndexes: 2,
    ttlMs: 60_000,
  });
  store.remember({ taskKey: 'header:task-a', checkpoint: `${VALID_CHECKPOINT}\nA`, responseId: 'resp_same' });
  store.remember({ taskKey: 'header:task-b', checkpoint: `${VALID_CHECKPOINT}\nB`, responseId: 'resp_same' });
  store.remember({ taskKey: 'header:task-c', checkpoint: `${VALID_CHECKPOINT}\nC`, responseId: 'resp_c' });

  assert.equal(store.taskForResponse('resp_same'), null); // 刷新歧义哨兵，使 C 成为最旧索引。
  store.remember({ taskKey: 'header:task-d', checkpoint: `${VALID_CHECKPOINT}\nD`, responseId: 'resp_d' });
  store.remember({ taskKey: 'header:task-b', checkpoint: `${VALID_CHECKPOINT}\nB2`, responseId: 'resp_same' });

  assert.equal(store.taskForResponse('resp_same'), null);
  assert.equal(store.taskForResponse('resp_c'), null);
  assert.match(store.getTask(store.taskForResponse('resp_d')), /D$/);
});

test('检查点快照只导出哈希索引并可在冷重启后恢复', () => {
  const now = () => 10_000;
  const first = new GoalCheckpointStore({ now, ttlMs: 60_000 });
  first.remember({
    taskKey: 'raw-task-id',
    exactKey: 'raw-exact-source',
    checkpoint: VALID_CHECKPOINT,
    responseId: 'raw-response-id',
  });

  const snapshot = first.exportSnapshot();
  const serialized = JSON.stringify(snapshot);
  assert.doesNotMatch(serialized, /raw-task-id|raw-exact-source|raw-response-id/);
  assert.match(serialized, /task:[a-f0-9]{64}/);
  assert.match(serialized, /response:[a-f0-9]{64}/);

  const restored = new GoalCheckpointStore({ now, ttlMs: 60_000 });
  assert.equal(restored.importSnapshot(snapshot), 1);
  assert.equal(restored.getTask('raw-task-id'), VALID_CHECKPOINT);
  assert.equal(restored.getExact('raw-exact-source'), VALID_CHECKPOINT);
  const restoredTask = restored.taskForResponse('raw-response-id');
  assert.match(restoredTask, /^task:[a-f0-9]{64}$/);
  assert.equal(restored.getTask(restoredTask), VALID_CHECKPOINT);
});

test('检查点快照恢复时丢弃过期项并保留 response 歧义哨兵', () => {
  let current = 1_000;
  const first = new GoalCheckpointStore({ now: () => current, ttlMs: 100 });
  first.remember({ taskKey: 'task-a', checkpoint: `${VALID_CHECKPOINT}\nA`, responseId: 'shared' });
  first.remember({ taskKey: 'task-b', checkpoint: `${VALID_CHECKPOINT}\nB`, responseId: 'shared' });
  const snapshot = first.exportSnapshot();

  const restored = new GoalCheckpointStore({ now: () => current, ttlMs: 100 });
  assert.equal(restored.importSnapshot(snapshot), 2);
  assert.equal(restored.taskForResponse('shared'), null);

  current = 2_000;
  const expired = new GoalCheckpointStore({ now: () => current, ttlMs: 100 });
  assert.equal(expired.importSnapshot(snapshot), 0);
  assert.equal(expired.getTask('task-a'), null);
});

test('清空检查点同时移除任务、精确来源、response 和并发序号', () => {
  const store = new GoalCheckpointStore();
  const sequence = store.beginTask('task-a');
  store.remember({
    taskKey: 'task-a',
    exactKey: 'exact-a',
    checkpoint: VALID_CHECKPOINT,
    responseId: 'response-a',
    requestSequence: sequence,
  });

  assert.equal(store.clear(), 1);
  assert.equal(store.getTask('task-a'), null);
  assert.equal(store.getExact('exact-a'), null);
  assert.equal(store.taskForResponse('response-a'), null);
  assert.equal(store.exportSnapshot().entries.length, 0);
});
