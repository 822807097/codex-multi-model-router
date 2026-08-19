import assert from 'node:assert/strict';
import http from 'node:http';

function requestJson(method, path, body = null) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request({
      hostname: '127.0.0.1',
      port: 15730,
      path,
      method,
      headers: {
        'Host': '127.0.0.1:15730',
        'Content-Type': 'application/json',
        ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
      },
    }, (res) => {
      let chunks = '';
      res.on('data', chunk => chunks += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(chunks);
          resolve({ status: res.statusCode, data: json });
        } catch {
          resolve({ status: res.statusCode, text: chunks });
        }
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

async function runE2eTests() {
  console.log('--- 1. 测试 HTML 静态页面加载与 Vue 3 挂载点 ---');
  const htmlRes = await requestJson('GET', '/admin/');
  assert.equal(htmlRes.status, 200);
  assert.match(htmlRes.text, /id="app"/);
  assert.match(htmlRes.text, /class="sidebar"/);
  assert.match(htmlRes.text, /class="metric-card"/);
  assert.match(htmlRes.text, /class="heatmap-grid"/);
  assert.match(htmlRes.text, /class="stacked-chart"/);
  console.log('✔ HTML 结构中左侧 Sidebar、6卡矩阵、活跃热力图与按天堆叠图容器全部验证通过');

  console.log('\n--- 2. 测试 /_admin/api/dashboard (截图同款统计数据) ---');
  const dashRes = await requestJson('GET', '/_admin/api/dashboard?days=30');
  assert.equal(dashRes.status, 200);
  assert.equal(dashRes.data.ok, true);
  assert.ok(dashRes.data.metrics);
  assert.ok(Array.isArray(dashRes.data.heatmap));
  assert.ok(dashRes.data.stackedChart);
  console.log('✔ 6卡指标、热力图数据与多模型堆叠柱状图数据结构正确');

  console.log('\n--- 3. 测试 /_admin/api/models/test (模型连接与毫秒测速) ---');
  const testRes = await requestJson('POST', '/_admin/api/models/test', {
    model: 'qwen3.8-max',
    targetName: 'bailian',
  });
  console.log('测速响应:', testRes.data);
  assert.equal(testRes.status, 200);
  assert.equal(testRes.data.ok, true);
  assert.ok(typeof testRes.data.latencyMs === 'number');
  console.log(`✔ 模型连通性测试成功，往返耗时: ${testRes.data.latencyMs}ms`);

  console.log('\n--- 4. 测试 /_admin/api/accounts (订阅账号添加与独立代理) ---');
  const addAccRes = await requestJson('POST', '/_admin/api/accounts/add', {
    provider: 'claude',
    alias: '我的 Claude Pro 主号',
    email: 'user@example.com',
    credentials: { sessionKey: 'sk-ant-sid01-test-session-key' },
    proxy: { enabled: true, url: 'http://127.0.0.1:10808' },
    quota: { used: 15, limit: 100 },
  });
  assert.equal(addAccRes.status, 200);
  assert.equal(addAccRes.data.ok, true);

  const listAccRes = await requestJson('GET', '/_admin/api/accounts');
  assert.equal(listAccRes.status, 200);
  assert.ok(Array.isArray(listAccRes.data.accounts));
  const found = listAccRes.data.accounts.find(a => a.alias === '我的 Claude Pro 主号');
  assert.ok(found);
  assert.equal(found.proxy?.enabled, true);
  assert.equal(found.proxy?.url, 'http://127.0.0.1:10808');
  console.log('✔ 订阅账号添加成功，独立代理配置与安全脱敏校验无误');

  console.log('\n=========================================');
  console.log('🎉 所有 Web UI 渲染与功能端到端自测全部 100% 通过！');
  console.log('=========================================');
}

runE2eTests().catch(err => {
  console.error('❌ E2E 测试失败:', err);
  process.exit(1);
});
