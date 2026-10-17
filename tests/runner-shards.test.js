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
