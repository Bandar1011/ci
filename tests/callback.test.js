const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const workflow = fs.readFileSync(path.join(__dirname, '../.github/workflows/sandy-public-callback.yml'), 'utf8');
const scripts = [...workflow.matchAll(/          script: \|\n((?:            .*\n|\n)*)/g)]
  .map(match => match[1].split('\n').map(line => line.slice(12)).join('\n'));
assert.equal(scripts.length, 2);
const requestId = 'f394f9cc-12ab-4ad8-9222-9a43bc9f5330';
const requestRunId = '1234567890123';
const publicRunId = 9876543210;
const workflowId = 456789;
const mainSha = 'a'.repeat(40), runSha = 'b'.repeat(40);

async function invoke(overrides = {}) {
  const calls = { relay: [], compare: [], outputs: {} };
  const run = {
    path: '.github/workflows/sandy-public-macos.yml', workflow_id: workflowId,
    event: 'repository_dispatch', status: 'completed', run_attempt: 1,
    display_title: `sandy-public-ci-${requestId}-${requestRunId}`,
    id: publicRunId, head_sha: runSha, ...overrides.run,
  };
  const context = {
    payload: { workflow_run: run, repository: { id: overrides.repositoryId ?? 1423816626 } },
    repo: overrides.repo || { owner: 'Bandar1011', repo: 'ci' },
  };
  const env = {
    GITHUB_RUN_ATTEMPT: '1', SANDY_PUBLIC_CI_WORKFLOW_ID: String(workflowId),
    SANDY_CALLBACK_ISSUE_NUMBER: '42', SANDY_PRIVATE_REPOSITORY_ID: '12345678', SANDY_SOURCE_REPOSITORY: 'fixture-source', ...overrides.env,
  };
  const github = {
    request: async (route, input) => {
      calls.relay.push({ route, input });
      return { data: overrides.repository || { id: 12345678, full_name: 'Bandar1011/fixture-source', private: true } };
    },
    rest: {
      repos: {
        getBranch: async (input) => {
          assert.equal(JSON.stringify(input), JSON.stringify({ owner: 'Bandar1011', repo: 'ci', branch: 'main' }));
          return { data: { commit: { sha: overrides.mainSha || mainSha } } };
        },
        compareCommitsWithBasehead: async (input) => {
          calls.compare.push(input); return { data: { status: overrides.comparisonStatus || 'ahead' } };
        },
      },
      issues: {
        get: async (input) => { calls.relay.push({ get: input }); return { data: overrides.issue || { number: 42 } }; },
        createComment: async (input) => { calls.relay.push({ comment: input }); },
      },
    },
  };
  const core = { setOutput: (name, value) => { calls.outputs[name] = value; } };
  const execute = source => vm.runInNewContext(`(async () => {\n${source}\n})()`, { context, github, core, process: { env } }, { timeout: 1000 });
  try {
    await execute(scripts[0]);
    Object.assign(env, { SANDY_REQUEST_ID: calls.outputs['request-id'], SANDY_REQUEST_RUN_ID: calls.outputs['request-run-id'], SANDY_PUBLIC_RUN_ID: calls.outputs['public-run-id'] });
    await execute(scripts[1]);
    return calls;
  } catch (error) { error.calls = calls; throw error; }
}

test('relays only three validated opaque IDs to the owned private issue', async () => {
  const calls = await invoke();
  assert.equal(calls.relay.length, 3);
  assert.equal(calls.relay[0].route, 'GET /repositories/{repository_id}');
  assert.equal(calls.relay[0].input.repository_id, 12345678);
  assert.equal(calls.relay[2].comment.owner, 'Bandar1011');
  assert.equal(calls.relay[2].comment.repo, 'fixture-source');
  assert.equal(calls.relay[2].comment.issue_number, 42);
  assert.deepEqual(JSON.parse(calls.relay[2].comment.body), {
    request_id: requestId, request_run_id: requestRunId, public_run_id: String(publicRunId),
  });
  assert.equal(JSON.stringify(calls.compare), JSON.stringify([{ owner: 'Bandar1011', repo: 'ci', basehead: `${runSha}...${mainSha}` }]));
});

test('accepts the workflow path with GitHub main-ref suffix', async () => {
  assert.equal((await invoke({ run: { path: '.github/workflows/sandy-public-macos.yml@main' } })).relay.length, 3);
});

for (const [label, overrides] of [
  ['wrong path', { run: { path: '.github/workflows/other.yml' } }],
  ['wrong workflow ID', { run: { workflow_id: 123 } }],
  ['wrong event', { run: { event: 'push' } }],
  ['incomplete run', { run: { status: 'in_progress' } }],
  ['source rerun', { run: { run_attempt: 2 } }],
  ['callback rerun', { env: { GITHUB_RUN_ATTEMPT: '2' } }],
  ['debug', { env: { RUNNER_DEBUG: '1' } }],
  ['step debug', { env: { ACTIONS_STEP_DEBUG: 'true' } }],
  ['wrong public repository', { repositoryId: 1 }],
  ['wrong public owner', { repo: { owner: 'other', repo: 'ci' } }],
  ['unbound request run ID', { run: { display_title: `sandy-public-ci-${requestId}-0` } }],
  ['malformed request ID', { run: { display_title: `sandy-public-ci-invalid-${requestRunId}` } }],
  ['public title injection', { run: { display_title: `sandy-public-ci-${requestId}-${requestRunId}\nprivate-text` } }],
  ['invalid public run ID', { run: { id: '123;evil' } }],
  ['invalid workflow SHA', { run: { head_sha: 'invalid' } }],
  ['missing workflow binding', { env: { SANDY_PUBLIC_CI_WORKFLOW_ID: '' } }],
  ['missing issue', { env: { SANDY_CALLBACK_ISSUE_NUMBER: '' } }],
  ['untrusted main history', { comparisonStatus: 'behind' }],
]) {
  test(`fails before callback credentials for ${label}`, async () => {
    await assert.rejects(invoke(overrides), error => { assert.equal(error.calls.relay.length, 0); return true; });
  });
}

for (const [label, overrides] of [
  ['foreign private repository ID', { repository: { id: 1, full_name: 'Bandar1011/fixture-source', private: true } }],
  ['foreign private repository name', { repository: { id: 12345678, full_name: 'other/repo', private: true } }],
  ['public source repository', { repository: { id: 12345678, full_name: 'Bandar1011/fixture-source', private: false } }],
  ['issue is pull request', { issue: { number: 42, pull_request: {} } }],
  ['wrong returned issue', { issue: { number: 43 } }],
  ['unsafe issue number', { env: { SANDY_CALLBACK_ISSUE_NUMBER: '99999999999999999999' } }],
]) {
  test(`rejects ${label} without posting a comment`, async () => {
    await assert.rejects(invoke(overrides), error => { assert.ok(!error.calls.relay.some(call => call.comment)); return true; });
  });
}

test('validation precedes minting a distinct Issues-only callback App', () => {
  assert.ok(workflow.indexOf('id: validate') < workflow.indexOf('id: callback-token'));
  assert.ok(workflow.includes('permission-issues: write'));
  assert.ok(workflow.includes('repositories: ${{ secrets.SANDY_SOURCE_REPOSITORY }}'));
  assert.ok(!workflow.includes('SANDY_SOURCE_APP_PRIVATE_KEY'));
  for (const source of scripts) assert.doesNotThrow(() => new vm.Script(`(async () => {\n${source}\n})()`));
});
