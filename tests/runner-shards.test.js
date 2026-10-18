const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const runner = fs.readFileSync(path.join(__dirname, '../runner/run-public-ci.sh'), 'utf8');
const workflow = fs.readFileSync(path.join(__dirname, '../.github/workflows/sandy-public-macos.yml'), 'utf8');

function accepts(value, pattern) {
  const result = spawnSync('bash', ['-c', 'pattern=$2; [[ $1 =~ $pattern ]]', 'bash', value, pattern]);
  assert.ifError(result.error);
  return result.status === 0;
}

test('every UI shard in the workflow can prepare and encrypt its result', () => {
  const shards = [...workflow.matchAll(/opaque: (b-\d+)/g)].map((match) => match[1]);
  assert.deepEqual(shards, ['b-1', 'b-2', 'b-3', 'b-4', 'b-5']);

  const prepare = runner.match(/if \[\[ "\$SANDY_OPAQUE_LANE" =~ (\^\S+) \]\]; then/);
  const encrypt = runner.match(/\[\[ "\$value" =~ (\^\S+) \]\] \|\| return 1/);
  assert.ok(prepare, 'runner must declare the UI shard prepare condition');
  assert.ok(encrypt, 'runner must declare the encrypted result ID validation');

  for (const shard of shards) {
    assert.ok(accepts(shard, prepare[1]), `${shard} must build on its runner`);
    assert.ok(accepts(shard, encrypt[1]), `${shard} must be accepted for encrypted upload`);
  }
  assert.ok(!accepts('b-6', prepare[1]));
  assert.ok(!accepts('b-6', encrypt[1]));
});


test('scheduled native graph matches the upstream four job types and nine expanded jobs', () => {
  const blocks = [...workflow.matchAll(/^  (prepare|lane-[a-z]):\n([\s\S]*?)(?=^  [a-z-]+:|$(?![\s\S]))/gm)];
  assert.deepEqual(blocks.map(match => match[1]), ['prepare', 'lane-a', 'lane-b', 'lane-c']);
  for (const [index, block] of blocks.entries()) {
    assert.ok(block[2].includes('runs-on: macos-26-intel'));
    assert.ok(block[2].includes(`timeout-minutes: ${index === 0 ? 40 : 120}`));
    assert.ok(block[2].includes(`timeout-minutes: ${index === 0 ? 30 : 105}`));
    if (index > 0) assert.ok(block[2].includes('needs: prepare'));
  }
  assert.deepEqual([...workflow.matchAll(/opaque: ([bc]-\d+)/g)].map(match => match[1]),
    ['b-1', 'b-2', 'b-3', 'b-4', 'b-5', 'c-1', 'c-2']);
  assert.ok(!workflow.includes('actions/cache@'));
  assert.ok(!workflow.includes('actions/download-artifact@'));
  assert.ok(workflow.includes('DEVELOPER_DIR: /Applications/Xcode_26.4.1.app/Contents/Developer'));
});


test('publishing allowlist excludes app source, secrets and operating instructions', () => {
  const root = path.join(__dirname, '..');
  const allowed = ['.gitignore', '.github/workflows/sandy-public-macos.yml',
    '.github/workflows/sandy-public-callback.yml', 'runner/run-public-ci.sh',
    'tests/callback.test.js', 'tests/runner-shards.test.js', 'tests/runner-security.test.js'];
  for (const file of [...allowed, 'App.swift', '.secrets/private.env', 'README.md']) {
    const result = spawnSync('git', ['check-ignore', '--no-index', '--quiet', file], { cwd: root });
    assert.ifError(result.error);
    assert.equal(result.status, allowed.includes(file) ? 1 : 0, file);
  }
});
