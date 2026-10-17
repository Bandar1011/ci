const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const crypto = require('node:crypto');

const original = fs.readFileSync(path.join(__dirname, '../runner/run-public-ci.sh'), 'utf8');
const workflow = fs.readFileSync(path.join(__dirname, '../.github/workflows/sandy-public-macos.yml'), 'utf8');
const requestId = '123e4567-e89b-42d3-a456-426614174000';
function command(exe, args, options = {}) {
  const result = spawnSync(exe, args, { encoding: 'utf8', ...options });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'owned-ci-runner-'));
  fs.chmodSync(root, 0o700);
  const tools = path.join(root, 'tools'); fs.mkdirSync(tools);
  const runner = path.join(root, 'runner.sh');
  // Change only executable lookup in the test copy; the production runner has
  // a fixed PATH and exposes no mock command or credential-routing override.
  const line = "readonly SAFE_PATH='/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin'";
  assert.equal(original.split(line).length, 2);
  fs.writeFileSync(runner, original.replace(line, `readonly SAFE_PATH='${tools}:/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin'`), { mode: 0o700 });
  const key = path.join(root, 'key.pem'), cert = path.join(root, 'cert.pem');
  command('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-sha256', '-nodes', '-subj', '/CN=synthetic-ci-test', '-keyout', key, '-out', cert, '-days', '1']);
  const der = spawnSync('openssl', ['x509', '-in', cert, '-outform', 'DER']).stdout;
  const fingerprint = crypto.createHash('sha256').update(der).digest('hex');
  const env = {
    ...process.env, RUNNER_TEMP: root, GITHUB_REPOSITORY: 'Bandar1011/ci', GITHUB_REPOSITORY_ID: '1423816626',
    GITHUB_SHA: 'e'.repeat(40), GITHUB_RUN_ATTEMPT: '1', RUNNER_DEBUG: '0', ACTIONS_STEP_DEBUG: 'false',
    SANDY_REQUEST_ID: requestId, SANDY_REQUEST_RUN_ID: '123', SANDY_PUBLIC_CI_WORKFLOW_ID: '456',
    SANDY_PRIVATE_REPOSITORY_ID: '12345678', SANDY_SOURCE_REPOSITORY: 'fixture-source',
    SANDY_CI_RECIPIENT_CERT: fs.readFileSync(cert, 'utf8'), SANDY_CI_RECIPIENT_CERT_SHA256: fingerprint,
    FIXTURE_ROOT: root,
  };
  const run = (mode, extra = {}) => spawnSync('/bin/bash', [runner, mode], { env: { ...env, ...extra }, encoding: 'utf8' });
  return { root, tools, runner, key, cert, env, run, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}
function prepareEvidence(f) {
  const workspace = path.join(f.root, 'sandy-private'); fs.mkdirSync(path.join(workspace, 'results'), { recursive: true });
  fs.writeFileSync(path.join(workspace, 'candidate.json'), JSON.stringify({ synthetic: true }));
  fs.writeFileSync(path.join(workspace, 'private.log'), 'private-canary-7a2e\n');
  fs.writeFileSync(path.join(workspace, 'results', 'test.log'), 'private-canary-7a2e\n');
  return workspace;
}
function prepareSource(f, edits = {}) {
  const repo = path.join(f.root, 'fixture-repository'); fs.mkdirSync(repo);
  const git = (...args) => command('/usr/bin/git', ['-C', repo, ...args]);
  git('init', '-b', 'base'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.invalid');
  const helper = path.join(repo, 'scripts/testing/public_ci/private_lane.py'); fs.mkdirSync(path.dirname(helper), { recursive: true });
  fs.writeFileSync(helper, '# candidate helper must not be trusted\n'); git('add', '.'); git('commit', '-m', 'base');
  const base = git('rev-parse', 'HEAD');
  git('checkout', '-b', 'candidate'); fs.writeFileSync(path.join(repo, 'candidate-input'), 'candidate\n'); git('add', '.'); git('commit', '-m', 'candidate');
  const head = git('rev-parse', 'HEAD');
  git('checkout', '-b', 'control', base); fs.writeFileSync(helper, '# reviewed control helper\n'); git('add', '.'); git('commit', '-m', 'control');
  const control = git('rev-parse', 'HEAD');
  const request = {
    request_id: requestId, repository_id: 12345678, public_repository_id: 1423816626, public_workflow_id: 456,
    request_run_id: 123, head_sha: head, base_sha: base, control_workflow_sha: control, public_workflow_sha: f.env.GITHUB_SHA,
    recipient_cert_sha256: f.env.SANDY_CI_RECIPIENT_CERT_SHA256,
    created_at: Math.floor(Date.now() / 1000), expires_at: Math.floor(Date.now() / 1000) + 3600,
    expected_jobs: ['test-products', 'critical-shards', 'swiftpm', 'w2-gate', 'release-build', 'source-fast', 'backend-integration'], ...edits,
  };
  fs.writeFileSync(path.join(f.root, 'request.json'), JSON.stringify(request));
  const gh = `#!/usr/bin/env python3
import json, os, pathlib, shutil, sys
root = pathlib.Path(os.environ['FIXTURE_ROOT'])
a = sys.argv[1:]
with (root / 'calls.jsonl').open('a') as log: log.write(json.dumps({'tool': 'gh', 'args': a, 'token_present': bool(os.environ.get('GH_TOKEN'))}) + '\\n')
if a[:2] == ['api', 'repositories/12345678']: print('Bandar1011/fixture-source')
elif a == ['api', '--method', 'DELETE', '/installation/token']: (root / 'revoked').touch()
elif a[:2] == ['run', 'download']:
    target = pathlib.Path(a[a.index('--dir') + 1]); target.mkdir(); shutil.copy(root / 'request.json', target / 'request.json')
else: raise SystemExit(1)
`;
  const gitMock = `#!/usr/bin/env python3
import json, os, pathlib, subprocess, sys
root = pathlib.Path(os.environ['FIXTURE_ROOT'])
a = sys.argv[1:]; token = os.environ.get('SANDY_SOURCE_TOKEN', '')
assert not token or not any(token in item for item in a)
helper = next((item.split('credential.helper=!', 1)[1].strip('"') for item in a if item.startswith('credential.helper=!')), None)
if helper:
    valid = subprocess.run([helper, 'get'], input='protocol=https\\nhost=github.com\\npath=Bandar1011/fixture-source.git\\n\\n', capture_output=True, text=True)
    assert valid.returncode == 0 and ('password=' + token) in valid.stdout
    foreign = subprocess.run([helper, 'get'], input='protocol=https\\nhost=github.com\\npath=foreign/repo.git\\n\\n', capture_output=True, text=True)
    assert foreign.returncode != 0 and not foreign.stdout
while a[:1] == ['-c']: a = a[2:]
with (root / 'calls.jsonl').open('a') as log: log.write(json.dumps({'tool': 'git', 'args': a, 'token_present': bool(token), 'revoked': (root / 'revoked').exists(), 'helper_scope_checked': bool(helper)}) + '\\n')
if a[:1] == ['clone']:
    assert '--filter=blob:none' not in a
    a[a.index('https://github.com/Bandar1011/fixture-source.git')] = str(root / 'fixture-repository')
    subprocess.run(['/usr/bin/git', *a], check=True)
    subprocess.run(['/usr/bin/git', '-C', a[-1], 'remote', 'set-url', 'origin', 'https://github.com/Bandar1011/fixture-source.git'], check=True)
elif 'fetch' in a:
    assert token and not (root / 'revoked').exists()
    a[a.index('origin')] = str(root / 'fixture-repository')
    subprocess.run(['/usr/bin/git', *a], check=True)
else:
    assert not token and (root / 'revoked').exists()
    raise SystemExit(subprocess.run(['/usr/bin/git', *a]).returncode)
`;
  fs.writeFileSync(path.join(f.tools, 'gh'), gh, { mode: 0o700 });
  fs.writeFileSync(path.join(f.tools, 'git'), gitMock, { mode: 0o700 });
  return request;
}

test('fetch uses immutable control helper and revokes source token before checkout and candidate merge', () => {
  const f = fixture();
  try {
    const request = prepareSource(f);
    const result = f.run('fetch', { SANDY_SOURCE_TOKEN: 'synthetic-reader-token' });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.equal(result.stdout.trim(), 'Private validation: succeeded');
    const workspace = path.join(f.root, 'sandy-private');
    assert.equal(fs.readFileSync(path.join(workspace, 'trusted/private_lane.py'), 'utf8'), '# reviewed control helper\n');
    assert.equal(fs.readFileSync(path.join(workspace, 'source/scripts/testing/public_ci/private_lane.py'), 'utf8'), '# candidate helper must not be trusted\n');
    assert.ok(!fs.existsSync(path.join(workspace, 'git-credential-helper')));
    assert.ok(!fs.readFileSync(path.join(workspace, 'source/.git/config'), 'utf8').includes('synthetic-reader-token'));
    const candidate = JSON.parse(fs.readFileSync(path.join(workspace, 'candidate.json')));
    assert.equal(candidate.control_workflow_sha, request.control_workflow_sha);
    const calls = fs.readFileSync(path.join(f.root, 'calls.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
    const checkout = calls.find(call => call.tool === 'git' && call.args.includes('checkout'));
    assert.equal(checkout.token_present, false); assert.equal(checkout.revoked, true);
    assert.equal(calls.filter(call => call.helper_scope_checked).length, 2);
    assert.equal(calls.filter(call => call.tool === 'gh' && call.args.includes('DELETE')).length, 1);
  } finally { f.cleanup(); }
});

test('request identity and expiry failures revoke reader without cloning private source', () => {
  const edits = [
    { public_workflow_sha: 'f'.repeat(40) }, { public_workflow_id: 1 }, { public_repository_id: 1 },
    { repository_id: 1 }, { recipient_cert_sha256: '0'.repeat(64) }, { control_workflow_sha: 'unreviewed' },
    { request_run_id: 1 }, { expires_at: 1 }, { expires_at: Math.floor(Date.now() / 1000) + 100000 },
  ];
  for (const edit of edits) {
    const f = fixture();
    try {
      prepareSource(f, edit);
      const result = f.run('fetch', { SANDY_SOURCE_TOKEN: 'synthetic-reader-token' });
      assert.notEqual(result.status, 0, JSON.stringify(edit));
      const calls = fs.readFileSync(path.join(f.root, 'calls.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
      assert.ok(!calls.some(call => call.tool === 'git'));
      assert.ok(fs.existsSync(path.join(f.root, 'revoked')));
    } finally { f.cleanup(); }
  }
});

test('rerun, debug and foreign public repository fail before credential use', () => {
  const f = fixture();
  try {
    prepareSource(f);
    for (const extra of [{ GITHUB_RUN_ATTEMPT: '2' }, { RUNNER_DEBUG: '1' }, { ACTIONS_STEP_DEBUG: 'true' }, { GITHUB_REPOSITORY: 'other/ci' }, { GITHUB_REPOSITORY_ID: '1' }, { RUNNER_OS: 'Linux', PATH: '/usr/bin:/bin' }]) {
      assert.notEqual(f.run('fetch', { SANDY_SOURCE_TOKEN: 'synthetic-reader-token', ...extra }).status, 0);
      assert.ok(!fs.existsSync(path.join(f.root, 'calls.jsonl')));
    }
  } finally { f.cleanup(); }
});

test('real CMS encryption protects every additional UI shard and production Release evidence', () => {
  for (const lane of ['b-4', 'b-5', 'c-3', 'd-1', 'd-2']) {
    const f = fixture();
    try {
      const workspace = prepareEvidence(f);
      const result = f.run('encrypt-result', { SANDY_RESULT_ID: lane });
      assert.equal(result.status, 0, result.stdout + result.stderr);
      assert.ok(!result.stdout.includes('private-canary'));
      const cipher = path.join(workspace, `result-${lane}.bundle.cms`);
      assert.ok(!fs.readFileSync(cipher).includes(Buffer.from('private-canary')));
      assert.ok(!fs.existsSync(path.join(workspace, `result-${lane}.bundle.tar.gz`)));
      const clear = path.join(f.root, 'clear.tar.gz');
      command('openssl', ['cms', '-decrypt', '-binary', '-inform', 'DER', '-in', cipher, '-recip', f.cert, '-inkey', f.key, '-out', clear]);
      assert.ok(command('tar', ['-xOzf', clear, 'results/test.log']).includes('private-canary'));
      const bytes = fs.readFileSync(cipher); bytes[bytes.length - 32] ^= 0x80; fs.writeFileSync(cipher, bytes);
      assert.notEqual(spawnSync('openssl', ['cms', '-decrypt', '-binary', '-inform', 'DER', '-in', cipher, '-recip', f.cert, '-inkey', f.key, '-out', clear]).status, 0);
    } finally { f.cleanup(); }
  }
});

test('wrong recipient, oversized files and symlink evidence fail without artifact upload', () => {
  for (const kind of ['recipient', 'size', 'symlink', 'lane']) {
    const f = fixture();
    try {
      const workspace = prepareEvidence(f);
      if (kind === 'size') {
        const fd = fs.openSync(path.join(workspace, 'results/oversized'), 'w'); fs.ftruncateSync(fd, 512 * 1024 * 1024 + 1); fs.closeSync(fd);
      }
      if (kind === 'symlink') fs.symlinkSync('/etc/hosts', path.join(workspace, 'results/linked'));
      const result = f.run('encrypt-result', { SANDY_RESULT_ID: kind === 'lane' ? '../../invalid' : 'a', ...(kind === 'recipient' ? { SANDY_CI_RECIPIENT_CERT_SHA256: '0'.repeat(64) } : {}) });
      assert.notEqual(result.status, 0);
      assert.ok(!fs.existsSync(path.join(workspace, 'result-a.bundle.cms')));
      assert.ok(!result.stdout.includes('private-canary'));
    } finally { f.cleanup(); }
  }
});

test('all jobs validate before source App access and upload encrypted files only', () => {
  const jobs = workflow.split(/^  (?:prepare|lane-[abcd]):$/m).slice(1);
  assert.equal(jobs.length, 5);
  for (const job of jobs) {
    assert.ok(job.indexOf('run-public-ci.sh guard') < job.indexOf('secrets.SANDY_SOURCE_APP_PRIVATE_KEY'));
    assert.ok(job.includes('permission-contents: read')); assert.ok(job.includes('permission-actions: read'));
    assert.ok(job.includes('repositories: ${{ secrets.SANDY_SOURCE_REPOSITORY }}')); assert.ok(job.includes('Discard source reader'));
    const upload = job.slice(job.indexOf('actions/upload-artifact@'));
    assert.ok(upload.includes('.bundle.cms')); assert.ok(!upload.includes('private.log'));
  }
  assert.deepEqual([...workflow.matchAll(/opaque: (c-\d+)/g)].map(match => match[1]), ['c-1', 'c-2', 'c-3']);
  assert.ok(!workflow.includes('secrets.SANDY_SOURCE_TOKEN'));
  assert.ok(!workflow.includes('SANDY_CALLBACK_APP_PRIVATE_KEY'));
});

test('Linux lanes use pinned Node24 setup before auth and preserve only a validated hosted tool-cache path', () => {
  const linux = workflow.split('  lane-d:', 2)[1];
  assert.ok(linux.includes('runs-on: ubuntu-latest'));
  assert.ok(!linux.includes('needs: prepare'));
  assert.ok(linux.indexOf('actions/setup-node@249970729cb0ef3589644e2896645e5dc5ba9c38') < linux.indexOf('run-public-ci.sh guard'));
  assert.ok(linux.includes("node-version: '24'"));
  assert.deepEqual([...linux.matchAll(/opaque: (d-\d+)/g)].map(match => match[1]), ['d-1', 'd-2']);
  assert.ok(original.includes('"$node_binary" --version'));
  assert.ok(original.includes('^/opt/hostedtoolcache/node/24\\.[0-9]+\\.[0-9]+/x64/bin/node$'));
  assert.ok(original.includes('if [[ ! "$SANDY_OPAQUE_LANE" =~ ^d-[1-2]$ ]]; then use_isolated_keychain; fi'));
  assert.ok(original.includes('PATH="$PRIVATE_PATH" HOME='));
});

test('Linux guard accepts hosted Node24 and rejects another major or an arbitrary Node path before authentication', () => {
  const f = fixture();
  try {
    const hostedRoot = path.join(f.root, 'hostedtoolcache');
    const bin = path.join(hostedRoot, 'node/24.99.99/x64/bin');
    fs.mkdirSync(bin, { recursive: true });
    const adapted = fs.readFileSync(f.runner, 'utf8');
    assert.equal(adapted.split('/opt/hostedtoolcache').length, 2);
    // Only the hosted cache root is relocated for this filesystem fixture.
    fs.writeFileSync(f.runner, adapted.replace('/opt/hostedtoolcache', hostedRoot));
    fs.writeFileSync(path.join(bin, 'node'), '#!/bin/bash\necho v24.99.99\n', { mode: 0o700 });
    const extra = { RUNNER_OS: 'Linux', PATH: `${bin}:${process.env.PATH}` };
    assert.equal(f.run('guard', extra).status, 0);
    fs.writeFileSync(path.join(bin, 'node'), '#!/bin/bash\necho v22.99.99\n');
    assert.notEqual(f.run('guard', extra).status, 0);
    const arbitrary = path.join(f.root, 'arbitrary-bin'); fs.mkdirSync(arbitrary);
    fs.writeFileSync(path.join(arbitrary, 'node'), '#!/bin/bash\necho v24.99.99\n', { mode: 0o700 });
    assert.notEqual(f.run('guard', { RUNNER_OS: 'Linux', PATH: `${arbitrary}:${process.env.PATH}` }).status, 0);
    assert.ok(!fs.existsSync(path.join(f.root, 'calls.jsonl')));
  } finally { f.cleanup(); }
});
