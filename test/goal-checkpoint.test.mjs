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

  assert.equal(resolveStrongTaskKey({ previous_response_id: 'resp-a' }, {}, store), taskKey);
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

  assert.equal(store.taskForResponse('resp-old'), 'header:a');
  assert.equal(store.taskForResponse('resp-new'), 'header:a');
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
  assert.equal(store.taskForResponse('resp-2'), 'header:a');
  assert.equal(store.taskForResponse('resp-3'), 'header:a');
});
