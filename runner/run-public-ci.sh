#!/usr/bin/env bash
set -Eeuo pipefail
readonly WORKSPACE="${RUNNER_TEMP:?}/sandy-private"
readonly MODE="${1:-}"
readonly REQUEST_RE='^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
readonly SAFE_PATH='/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin'
node_tool_bin=''
if [[ "${RUNNER_OS:-}" == Linux ]]; then
  node_binary="$(command -v node || true)"
  [[ "$node_binary" =~ ^/opt/hostedtoolcache/node/24\.[0-9]+\.[0-9]+/x64/bin/node$ ]] || exit 1
  [[ "$("$node_binary" --version)" =~ ^v24\.[0-9]+\.[0-9]+$ ]] || exit 1
  node_tool_bin="${node_binary%/node}"
fi
readonly PRIVATE_PATH="${node_tool_bin:+$node_tool_bin:}$SAFE_PATH"
export PATH="$PRIVATE_PATH"
unset BASH_ENV ENV CDPATH GLOBIGNORE || true
umask 077
mkdir -p "$WORKSPACE" >/dev/null 2>&1
status=1
stage=0
encryption_stage=''
# Bash may run EXIT while the private-log redirect is still active.
# Only packaging modes retain a descriptor for fixed public phase markers.
if [[ "$MODE" == encrypt-prepare || "$MODE" == encrypt-result ]]; then exec 3>&1; fi
auth_helper=''
revoke_on_exit=0
revoke_source_token() {
  if [[ -n "${SANDY_SOURCE_TOKEN:-}" ]]; then
    local revoke_status=0
    GH_TOKEN="$SANDY_SOURCE_TOKEN" gh api --method DELETE /installation/token >/dev/null 2>&1 || revoke_status=1
    unset SANDY_SOURCE_TOKEN GH_TOKEN GITHUB_TOKEN SANDY_PRIVATE_REPOSITORY_PATH
    [[ -z "$auth_helper" ]] || rm -f "$auth_helper"
    auth_helper=''
    return "$revoke_status"
  fi
}
finish() {
  local code=$?
  if [[ "$revoke_on_exit" == 1 ]] && ! revoke_source_token; then code=1; fi
  unset SANDY_SOURCE_TOKEN GH_TOKEN GITHUB_TOKEN SANDY_PRIVATE_REPOSITORY_PATH
  if [[ "$status" == 0 && "$code" == 0 ]]; then
    echo 'Private validation: succeeded'
  elif [[ "$MODE" == fetch ]]; then
    echo "Private validation: failed (stage $stage)"
  elif [[ "$MODE" == encrypt-* && "$encryption_stage" =~ ^(certificate|manifest|tar|cipher)$ ]]; then
    echo "Private validation: failed (encryption stage $encryption_stage)" >&3
  else
    echo 'Private validation: failed'
  fi
  [[ "$status" == 0 && "$code" == 0 ]] || exit 1
}
trap finish EXIT
fail() { return 1; }

# Fail before authentication, request download or private checkout.
[[ "${ACTIONS_STEP_DEBUG:-false}" != true && "${RUNNER_DEBUG:-0}" != 1 ]] || exit 1
[[ "${GITHUB_RUN_ATTEMPT:-1}" == 1 ]] || exit 1
[[ "${GITHUB_REPOSITORY:-}" == Bandar1011/ci ]] || exit 1
[[ "${GITHUB_REPOSITORY_ID:-}" == 1423816626 ]] || exit 1
[[ "${SANDY_REQUEST_ID:-}" =~ $REQUEST_RE ]] || exit 1
[[ "${SANDY_REQUEST_RUN_ID:-}" =~ ^[1-9][0-9]{0,19}$ ]] || exit 1
[[ "$MODE" =~ ^(guard|fetch|prepare|run-lane|encrypt-prepare|encrypt-result)$ ]] || exit 1
[[ "${GITHUB_SHA:-}" =~ ^[0-9a-f]{40}$ ]] || exit 1
[[ "${SANDY_PUBLIC_CI_WORKFLOW_ID:-}" =~ ^[1-9][0-9]{0,19}$ ]] || exit 1
[[ "$MODE" != fetch ]] || revoke_on_exit=1

recipient_certificate() {
  local output="$WORKSPACE/recipient.pem" fingerprint
  [[ -n "${SANDY_CI_RECIPIENT_CERT:-}" ]] || return 1
  [[ "${SANDY_CI_RECIPIENT_CERT_SHA256:-}" =~ ^[0-9a-f]{64}$ ]] || return 1
  printf '%s\n' "$SANDY_CI_RECIPIENT_CERT" > "$output"
  openssl x509 -in "$output" -checkend 0 -noout >/dev/null 2>&1 || return 1
  fingerprint="$(openssl x509 -in "$output" -outform DER | openssl dgst -sha256 | awk '{print $NF}')"
  [[ "$fingerprint" == "$SANDY_CI_RECIPIENT_CERT_SHA256" ]] || return 1
  printf '%s' "$output"
}
private_exec() {
  local entrypoint="$WORKSPACE/trusted/private_lane.py"
  [[ -f "$entrypoint" && ! -L "$entrypoint" ]] || fail
  [[ -z "${SANDY_SOURCE_TOKEN:-}" && -z "$auth_helper" ]] || fail
  /usr/bin/env -i \
    PATH="$PRIVATE_PATH" HOME="${HOME:-/tmp}" TMPDIR="${TMPDIR:-/tmp}" \
    DEVELOPER_DIR="${DEVELOPER_DIR:-}" RUNNER_TEMP="$RUNNER_TEMP" \
    SANDY_SOURCE_ROOT="$WORKSPACE/source" SANDY_PRIVATE_ROOT="$WORKSPACE" \
    SANDY_TEST_ARTIFACTS="$WORKSPACE/results" SANDY_TEST_DERIVED_DATA="$WORKSPACE/derived" \
    PREPARE_RESULT="${PREPARE_RESULT:-}" LANE_A_RESULT="${LANE_A_RESULT:-}" \
    LANE_B_RESULT="${LANE_B_RESULT:-}" LANE_C_RESULT="${LANE_C_RESULT:-}" LANE_D_RESULT="${LANE_D_RESULT:-}" \
    PUBLIC_RUN_ID="${PUBLIC_RUN_ID:-}" python3 "$entrypoint" "$@"
}
use_isolated_keychain() {
  local keychain="$WORKSPACE/ci.keychain-db" password
  password="$(openssl rand -hex 32)"
  security create-keychain -p "$password" "$keychain"
  security unlock-keychain -p "$password" "$keychain"
  unset password
  security set-keychain-settings -lut 14400 "$keychain"
  security list-keychains -d user -s "$keychain"
  security default-keychain -d user -s "$keychain"
}
bounded_tar() {
  python3 - "$WORKSPACE" "$1" "$2" <<'PY'
import stat, sys, tarfile
from pathlib import Path
workspace, name, output = Path(sys.argv[1]), sys.argv[2], Path(sys.argv[3])
root = workspace / name
members = [root]
for item in root.rglob("*"):
    if len(members) >= 100_000: raise SystemExit("evidence member limit")
    members.append(item)
members.sort()
total = 0
for item in members:
    mode = item.lstat().st_mode
    if not (stat.S_ISREG(mode) or stat.S_ISDIR(mode)): raise SystemExit("unsupported evidence file")
    if stat.S_ISREG(mode):
        size = item.stat().st_size
        if size > 512 * 1024 * 1024: raise SystemExit("evidence file limit")
        total += size
        if total > 2 * 1024 * 1024 * 1024: raise SystemExit("evidence total limit")
with tarfile.open(output, "w:gz", dereference=False) as archive:
    for item in members:
        archive.add(item, arcname=item.relative_to(workspace).as_posix(), recursive=False)
if output.stat().st_size > 1024 * 1024 * 1024: raise SystemExit("artifact transport limit")
PY
}
encrypt_cms() {
  local certificate
  certificate="$(recipient_certificate)"
  openssl cms -encrypt -aes-256-gcm -binary -outform DER \
    -in "$1" -out "$2" "$certificate" >/dev/null 2>&1 || fail
  [[ -s "$2" ]] || fail
  python3 - "$2" <<'PY'
from pathlib import Path
import sys
if Path(sys.argv[1]).stat().st_size > 1024 * 1024 * 1024: raise SystemExit(1)
PY
  rm -f "$1"
}
safe_result_id() {
  local value="${SANDY_RESULT_ID:-}"
  [[ "$value" =~ ^(a|b-[1-5]|c-[1-3]|d-[1-2])$ ]] || return 1
  printf '%s' "$value"
}

main() {
  [[ "$MODE" != encrypt-* ]] || encryption_stage=certificate
  recipient_certificate >/dev/null
  if [[ "$MODE" == guard ]]; then status=0; return 0; fi
  if [[ "$MODE" == fetch ]]; then
    [[ -n "${SANDY_SOURCE_TOKEN:-}" ]] || fail
    stage=1
    [[ "${SANDY_PRIVATE_REPOSITORY_ID:-}" =~ ^[1-9][0-9]{0,19}$ ]] || fail
    [[ "${SANDY_SOURCE_REPOSITORY:-}" =~ ^[A-Za-z0-9_.-]+$ ]] || fail
    private_repository="$(GH_TOKEN="$SANDY_SOURCE_TOKEN" gh api "repositories/$SANDY_PRIVATE_REPOSITORY_ID" --jq .full_name 2>/dev/null)"
    [[ "$private_repository" == "Bandar1011/$SANDY_SOURCE_REPOSITORY" ]] || fail
    stage=2
    [[ ! -e "$WORKSPACE/request-artifact" && ! -e "$WORKSPACE/source" ]] || fail
    GH_TOKEN="$SANDY_SOURCE_TOKEN" gh run download "$SANDY_REQUEST_RUN_ID" --repo "$private_repository" \
      --name "sandy-private-request-$SANDY_REQUEST_ID" --dir "$WORKSPACE/request-artifact" >/dev/null 2>&1
    [[ -f "$WORKSPACE/request-artifact/request.json" && ! -L "$WORKSPACE/request-artifact/request.json" ]] || fail
    cp "$WORKSPACE/request-artifact/request.json" "$WORKSPACE/request.json"
    stage=3
    python3 - "$WORKSPACE/request.json" "$SANDY_REQUEST_ID" "$SANDY_REQUEST_RUN_ID" \
      "${GITHUB_SHA:-}" "$SANDY_CI_RECIPIENT_CERT_SHA256" "$SANDY_PUBLIC_CI_WORKFLOW_ID" <<'PY'
import json, os, re, sys, time
from pathlib import Path
path = Path(sys.argv[1])
if path.stat().st_size > 65_536: raise SystemExit(1)
d = json.loads(path.read_text())
if d.get("request_id") != sys.argv[2] or str(d.get("repository_id")) != os.environ["SANDY_PRIVATE_REPOSITORY_ID"]: raise SystemExit(1)
if str(d.get("request_run_id")) != sys.argv[3]: raise SystemExit(1)
for key in ("head_sha", "base_sha", "public_workflow_sha", "control_workflow_sha"):
    if not isinstance(d.get(key), str) or not re.fullmatch(r"[0-9a-f]{40}", d[key]): raise SystemExit(1)
if d["public_workflow_sha"] != sys.argv[4] or d.get("public_repository_id") != 1423816626: raise SystemExit(1)
if d.get("recipient_cert_sha256") != sys.argv[5]: raise SystemExit(1)
if not re.fullmatch(r"[1-9][0-9]{0,19}", sys.argv[6]) or str(d.get("public_workflow_id")) != sys.argv[6]: raise SystemExit(1)
now = int(time.time())
created, expires = d.get("created_at"), d.get("expires_at")
if type(created) is not int or type(expires) is not int: raise SystemExit(1)
if created > now + 300 or expires <= now or expires <= created or expires - created > 86_400: raise SystemExit(1)
if d.get("expected_jobs") != ["test-products", "critical-shards", "swiftpm", "w2-gate", "release-build", "source-fast", "backend-integration"]: raise SystemExit(1)
PY
    head_sha="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["head_sha"])' "$WORKSPACE/request.json")"
    base_sha="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["base_sha"])' "$WORKSPACE/request.json")"
    control_sha="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["control_workflow_sha"])' "$WORKSPACE/request.json")"
    merge_date="$(python3 -c 'import datetime,json,sys; d=json.load(open(sys.argv[1])); print(datetime.datetime.fromtimestamp(d["created_at"],datetime.timezone.utc).isoformat())' "$WORKSPACE/request.json")"
    export SANDY_PRIVATE_REPOSITORY_PATH="$private_repository.git"
    auth_helper="$WORKSPACE/git-credential-helper"
    cat > "$auth_helper" <<'AUTH'
#!/usr/bin/env bash
set -eu
[[ "${1:-}" == get && -n "${SANDY_SOURCE_TOKEN:-}" ]] || exit 0
protocol='' host='' path=''
while IFS='=' read -r key value && [[ -n "$key" ]]; do
  case "$key" in protocol) protocol="$value";; host) host="$value";; path) path="$value";; esac
done
[[ "$protocol" == https && "$host" == github.com && "$path" == "${SANDY_PRIVATE_REPOSITORY_PATH:?}" ]] || exit 1
printf 'username=x-access-token\npassword=%s\n\n' "$SANDY_SOURCE_TOKEN"
AUTH
    chmod 700 "$auth_helper"
    export SANDY_SOURCE_TOKEN GIT_TERMINAL_PROMPT=0 GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null
    auth_git() { git -c credential.helper= -c "credential.helper=!\"$auth_helper\"" -c credential.useHttpPath=true "$@"; }
    stage=4
    auth_git clone --no-checkout --no-tags \
      "https://github.com/$private_repository.git" "$WORKSPACE/source" >/dev/null 2>&1
    stage=5
    auth_git -C "$WORKSPACE/source" fetch --quiet --no-tags origin "$head_sha" "$base_sha" "$control_sha"
    stage=6
    revoke_source_token || fail
    unset -f auth_git
    git -C "$WORKSPACE/source" checkout --quiet --detach "$base_sha"
    mkdir -p "$WORKSPACE/trusted"
    trusted_path='scripts/testing/public_ci/private_lane.py'
    git -C "$WORKSPACE/source" cat-file -e "$control_sha:$trusted_path" || fail
    git -C "$WORKSPACE/source" show "$control_sha:$trusted_path" > "$WORKSPACE/trusted/private_lane.py"
    stage=7
    GIT_AUTHOR_DATE="$merge_date" GIT_COMMITTER_DATE="$merge_date" \
      git -C "$WORKSPACE/source" -c user.name='CI' -c user.email='ci@users.noreply.github.com' \
      merge --no-ff --no-edit "$head_sha" >/dev/null 2>&1 || fail
    [[ "$(git -C "$WORKSPACE/source" remote get-url origin)" == "https://github.com/$private_repository.git" ]] || fail
    stage=8
    python3 - "$WORKSPACE/source" "$WORKSPACE/candidate.json" "$head_sha" "$base_sha" "$control_sha" <<'PY'
import json, subprocess, sys
source, output, head_sha, base_sha, control_sha = sys.argv[1:]
tree = subprocess.check_output(["git", "-C", source, "rev-parse", "HEAD^{tree}"], text=True).strip()
json.dump({"head_sha": head_sha, "base_sha": base_sha, "control_workflow_sha": control_sha,
           "candidate_tree_sha": tree}, open(output, "w"), sort_keys=True)
PY
    status=0
    return 0
  fi
  mkdir -p "$WORKSPACE/results" "$WORKSPACE/products"
  case "$MODE" in
    prepare)
      use_isolated_keychain
      private_exec prepare
      [[ -d "$WORKSPACE/products" ]] || fail
      ;;
    run-lane)
      [[ "${SANDY_OPAQUE_LANE:-}" =~ ^(a|b-[1-5]|c-[1-3]|d-[1-2])$ ]] || fail
      if [[ ! "$SANDY_OPAQUE_LANE" =~ ^d-[1-2]$ ]]; then use_isolated_keychain; fi
      if [[ "$SANDY_OPAQUE_LANE" =~ ^b-[1-5]$ ]]; then private_exec prepare; fi
      private_exec run --lane "$SANDY_OPAQUE_LANE"
      ;;
    encrypt-prepare)
      encryption_stage=manifest
      mkdir -p "$WORKSPACE/products-evidence"
      [[ -f "$WORKSPACE/private.log" && -f "$WORKSPACE/candidate.json" ]] || fail
      cp "$WORKSPACE/private.log" "$WORKSPACE/products-evidence/private.log"
      cp "$WORKSPACE/candidate.json" "$WORKSPACE/products-evidence/candidate.json"
      python3 - "$WORKSPACE/products" "$WORKSPACE/products-evidence/products-manifest.json" <<'PY'
import hashlib, json, os, stat, sys
from pathlib import Path
root, output = Path(sys.argv[1]), Path(sys.argv[2])
records = []
file_count = symlink_count = 0

def inspect(directory_fd, prefix=""):
    global file_count, symlink_count
    # Directory descriptors and O_NOFOLLOW keep traversal and hashing inside
    # actual product directories. Link targets are metadata, never input files.
    with os.scandir(directory_fd) as entries:
        names = sorted(entry.name for entry in entries)
    for name in names:
        relative = f"{prefix}/{name}" if prefix else name
        mode = os.stat(name, dir_fd=directory_fd, follow_symlinks=False).st_mode
        if stat.S_ISLNK(mode):
            records.append({"path": relative, "type": "symlink", "target": os.readlink(name, dir_fd=directory_fd)})
            symlink_count += 1
        elif stat.S_ISDIR(mode):
            child = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=directory_fd)
            try:
                inspect(child, relative)
            finally:
                os.close(child)
        elif stat.S_ISREG(mode):
            item_hash = hashlib.sha256()
            descriptor = os.open(name, os.O_RDONLY | os.O_NOFOLLOW, dir_fd=directory_fd)
            with os.fdopen(descriptor, "rb") as stream:
                if not stat.S_ISREG(os.fstat(stream.fileno()).st_mode): raise SystemExit(1)
                for chunk in iter(lambda: stream.read(1024 * 1024), b""): item_hash.update(chunk)
            records.append({"path": relative, "sha256": item_hash.hexdigest()})
            file_count += 1
        else:
            raise SystemExit(1)

root_fd = os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
try:
    inspect(root_fd)
finally:
    os.close(root_fd)
if not file_count: raise SystemExit(1)
digest = hashlib.sha256()
for record in sorted(records, key=lambda item: item["path"]):
    digest.update(json.dumps(record, sort_keys=True, separators=(",", ":")).encode())
output.write_text(json.dumps({"file_count": file_count, "symlink_count": symlink_count,
                             "sha256": digest.hexdigest()}, sort_keys=True) + "\n")
PY
      encryption_stage=tar
      bounded_tar products-evidence "$WORKSPACE/prepare.bundle.tar.gz"
      encryption_stage=cipher
      encrypt_cms "$WORKSPACE/prepare.bundle.tar.gz" "$WORKSPACE/prepare.bundle.cms"
      ;;
    encrypt-result)
      encryption_stage=manifest
      [[ -f "$WORKSPACE/private.log" && -f "$WORKSPACE/candidate.json" ]] || fail
      cp "$WORKSPACE/private.log" "$WORKSPACE/results/private.log"
      cp "$WORKSPACE/candidate.json" "$WORKSPACE/results/candidate.json"
      result_id="$(safe_result_id)"
      encryption_stage=tar
      bounded_tar results "$WORKSPACE/result-$result_id.bundle.tar.gz"
      encryption_stage=cipher
      encrypt_cms "$WORKSPACE/result-$result_id.bundle.tar.gz" "$WORKSPACE/result-$result_id.bundle.cms"
      ;;
  esac
  status=0
}
main >>"$WORKSPACE/private.log" 2>&1
