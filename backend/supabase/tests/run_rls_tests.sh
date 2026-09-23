#!/usr/bin/env bash
# Schema and RLS tests for backend/supabase against a throwaway PostgreSQL
# cluster (Unix socket only, removed afterwards). Never touches a real project.
#
# Requirements: PostgreSQL server binaries (initdb, pg_ctl, postgres, psql,
# pg_dump, pg_config) and pgvector for the same server version, e.g. on
# Debian / Ubuntu: apt-get install postgresql-16 postgresql-16-pgvector.
# python3 is optional (used to exercise apply_migration.py).
#
# Environment:
#   PG_BIN          directory with the PostgreSQL binaries
#                   (default: /usr/lib/postgresql/16/bin)
#   PGTEST_DIR      working directory to create (default: new temp directory);
#                   must not exist yet, removed at the end
#   PGTEST_PORT     port for the socket name (default: 55432)
#   PGTEST_OS_USER  OS user that runs the server when started as root
#                   (default: postgres)
#   PGTEST_KEEP=1   keep the working directory (logs, data) for debugging
#
# Scenarios:
#   live         live-shape reconstruction + legacy rows, migration x2, tests,
#                migration again, data-preservation checks
#   fresh        full_schema.sql (via apply_migration.py) + migration, tests
#   fresh_rerun  schema.sql (psql include of full_schema.sql), full_schema.sql
#                again, tests
#   legacy_v2    previous full_schema.sql + legacy rows, migration x2, tests
#   legacy_v1    previous schema.sql + legacy rows, migration x2, tests
#   guard        full_schema.sql must refuse a pre-hardening database
# plus: the public schema dumps of live, fresh and fresh_rerun are identical.
#
# Exit code: 0 when everything passes, 1 on any failure, 2 on setup errors.

set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
supabase_dir="$(dirname "$here")"
pg_bin="${PG_BIN:-/usr/lib/postgresql/16/bin}"
port="${PGTEST_PORT:-55432}"
os_user="${PGTEST_OS_USER:-postgres}"

die() { echo "error: $*" >&2; exit 2; }

for tool in initdb pg_ctl postgres psql pg_dump pg_config; do
    [[ -x "$pg_bin/$tool" ]] || die "$pg_bin/$tool not found; set PG_BIN to the PostgreSQL bin directory"
done
[[ -f "$("$pg_bin/pg_config" --sharedir)/extension/vector.control" ]] \
    || die "pgvector is not installed for $("$pg_bin/postgres" --version) (e.g. apt-get install postgresql-16-pgvector)"

shopt -s nullglob
migrations=("$supabase_dir"/migrations/*.sql)
shopt -u nullglob
(( ${#migrations[@]} > 0 )) || die "no migrations found in $supabase_dir/migrations"

if [[ -n "${PGTEST_DIR:-}" ]]; then
    [[ ! -e "$PGTEST_DIR" ]] || die "PGTEST_DIR $PGTEST_DIR already exists"
    mkdir -p "$PGTEST_DIR"
    work="$(cd "$PGTEST_DIR" && pwd)"
else
    work="$(mktemp -d "${TMPDIR:-/tmp}/starpi-rls.XXXXXX")"
fi
mkdir -p "$work/logs"

# initdb / postgres refuse to run as root.
run_as_root=0
[[ "$(id -u)" == "0" ]] && run_as_root=1
as_server() {
    if (( run_as_root )); then
        runuser -u "$os_user" -- "$@"
    else
        "$@"
    fi
}

server_started=0
cleanup() {
    local rc=$?
    if (( server_started )); then
        as_server "$pg_bin/pg_ctl" -D "$work/data" -m fast -w stop >/dev/null 2>&1 || true
    fi
    if [[ "${PGTEST_KEEP:-0}" == "1" ]]; then
        echo "kept $work"
    else
        rm -rf "$work"
    fi
    exit "$rc"
}
trap cleanup EXIT

if (( run_as_root )); then
    id "$os_user" >/dev/null 2>&1 || die "running as root needs the OS user '$os_user' (set PGTEST_OS_USER)"
    chown -R "$os_user" "$work"
    as_server test -w "$work" \
        || die "'$os_user' cannot write to $work (a parent directory is not accessible); set PGTEST_DIR"
fi

as_server "$pg_bin/initdb" -D "$work/data" -U postgres --auth=trust \
    -E UTF8 --locale=C.UTF-8 >"$work/logs/initdb.log" 2>&1 \
    || { cat "$work/logs/initdb.log" >&2; die "initdb failed"; }
as_server "$pg_bin/pg_ctl" -D "$work/data" -l "$work/logs/server.log" -w \
    -o "-p $port -k $work -c listen_addresses=''" start >/dev/null \
    || { cat "$work/logs/server.log" >&2; die "could not start PostgreSQL"; }
server_started=1

psql_cmd=("$pg_bin/psql" -X -q -v ON_ERROR_STOP=1 -h "$work" -p "$port" -U postgres)

psql_file() {
    local db="$1" file="$2"
    shift 2
    "${psql_cmd[@]}" -d "$db" "$@" -f "$file"
}

run_step() {
    local db="$1" step="$2"
    case "$step" in
        stub)
            psql_file "$db" "$here/stub_supabase.sql" ;;
        migrations)
            local m
            for m in "${migrations[@]}"; do
                psql_file "$db" "$m" || return 1
            done ;;
        test)
            psql_file "$db" "$here/rls_test.sql" -v legacy=false ;;
        test-legacy)
            psql_file "$db" "$here/rls_test.sql" -v legacy=true ;;
        post-rerun)
            psql_file "$db" "$here/post_rerun_check.sql" ;;
        apply-py:*)
            local file="${step#apply-py:}"
            if command -v python3 >/dev/null 2>&1; then
                PATH="$pg_bin:$PATH" \
                    DATABASE_URL="postgresql://postgres@/$db?host=$work&port=$port" \
                    python3 "$supabase_dir/apply_migration.py" "$file"
            else
                echo "python3 not found, applying $file with psql"
                psql_file "$db" "$file"
            fi ;;
        expect-fail:*)
            local file="${step#expect-fail:}"
            if psql_file "$db" "$file"; then
                echo "expected $file to fail, but it succeeded"
                return 1
            fi
            echo "failed as expected" ;;
        *)
            psql_file "$db" "$step" ;;
    esac
}

failures=0

run_scenario() {
    local name="$1"
    shift
    local db="starpi_$name" log="$work/logs/$name.log" step
    "${psql_cmd[@]}" -d postgres -c "create database $db" >"$log" 2>&1 \
        || { echo "FAIL  $name (create database)"; failures=$((failures + 1)); return 0; }
    for step in "$@"; do
        echo "--- step: $step" >>"$log"
        if ! run_step "$db" "$step" >>"$log" 2>&1; then
            echo "FAIL  $name (step: $step)"
            tail -n 30 "$log" | sed 's/^/      /'
            failures=$((failures + 1))
            return 0
        fi
    done
    local passed
    passed="$(grep -Eo '(rls_test|post_rerun_check): [0-9]+ checks passed' "$log" | paste -sd ';' - || true)"
    echo "PASS  $name${passed:+ ($passed)}"
}

dump_schema() {
    # \restrict / \unrestrict carry a random key in newer pg_dump releases.
    "$pg_bin/pg_dump" -h "$work" -p "$port" -U postgres --schema-only --schema=public "starpi_$1" \
        | grep -Ev '^\\(un)?restrict ' >"$work/logs/$1.schema.sql"
}

echo "PostgreSQL: $("$pg_bin/postgres" --version); work dir: $work"

fixtures="$here/fixtures"
run_scenario live stub "$fixtures/live_shape.sql" "$fixtures/legacy_seed.sql" \
    migrations migrations test-legacy migrations post-rerun
run_scenario fresh stub "apply-py:$supabase_dir/full_schema.sql" migrations test
run_scenario fresh_rerun stub "$supabase_dir/schema.sql" "$supabase_dir/full_schema.sql" test
run_scenario legacy_v2 stub "$fixtures/legacy_full_schema_v2.sql" "$fixtures/legacy_seed.sql" \
    migrations migrations test-legacy
run_scenario legacy_v1 stub "$fixtures/legacy_schema_v1.sql" "$fixtures/legacy_seed.sql" \
    migrations migrations test-legacy
run_scenario guard stub "$fixtures/live_shape.sql" "expect-fail:$supabase_dir/full_schema.sql"

if dump_schema live && dump_schema fresh && dump_schema fresh_rerun \
    && diff -u "$work/logs/live.schema.sql" "$work/logs/fresh.schema.sql" \
    && diff -u "$work/logs/fresh.schema.sql" "$work/logs/fresh_rerun.schema.sql"; then
    echo "PASS  schema parity (live + migration == full_schema.sql + migration == full_schema.sql)"
else
    echo "FAIL  schema parity"
    failures=$((failures + 1))
fi

if (( failures > 0 )); then
    echo "$failures check group(s) failed"
    exit 1
fi
echo "all checks passed"
