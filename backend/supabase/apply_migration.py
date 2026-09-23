#!/usr/bin/env python3
"""Apply Starpi SQL files to a Postgres / Supabase database.

The connection string is read from the DATABASE_URL environment variable
(Supabase dashboard: Connect > connection string, "Direct connection" or
"Session pooler"). Nothing about the target is hard-coded.

Examples:
    # fresh project: canonical schema
    DATABASE_URL=postgresql://... python backend/supabase/apply_migration.py

    # existing project: one migration, or every file in migrations/ in order
    DATABASE_URL=postgresql://... python backend/supabase/apply_migration.py \
        backend/supabase/migrations/20260923000000_harden_rls_anonymous_auth.sql
    DATABASE_URL=postgresql://... python backend/supabase/apply_migration.py --migrations

    # show what would run, without connecting
    python backend/supabase/apply_migration.py --migrations --dry-run

Uses psycopg (3) or psycopg2 when one of them is installed, otherwise the
psql command line client. The SQL files manage their own transactions.

Exit codes: 0 success, 1 SQL or connection error, 2 usage / setup error.
"""

import argparse
import os
import re
import shutil
import subprocess
import sys
from collections.abc import Sequence
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import parse_qsl, unquote, urlsplit

SUPABASE_DIR = Path(__file__).resolve().parent
DEFAULT_SCHEMA = SUPABASE_DIR / "full_schema.sql"
MIGRATIONS_DIR = SUPABASE_DIR / "migrations"
URL_ENV_VAR = "DATABASE_URL"

# Connection URL query parameters that psql understands as environment variables.
_QUERY_TO_PGENV: dict[str, str] = {
    "host": "PGHOST",
    "hostaddr": "PGHOSTADDR",
    "port": "PGPORT",
    "user": "PGUSER",
    "password": "PGPASSWORD",
    "dbname": "PGDATABASE",
    "sslmode": "PGSSLMODE",
    "sslrootcert": "PGSSLROOTCERT",
    "sslcert": "PGSSLCERT",
    "sslkey": "PGSSLKEY",
    "connect_timeout": "PGCONNECT_TIMEOUT",
    "application_name": "PGAPPNAME",
    "options": "PGOPTIONS",
    "target_session_attrs": "PGTARGETSESSIONATTRS",
}

_PSQL_META_COMMAND = re.compile(r"^\s*\\", re.MULTILINE)


class ApplyError(Exception):
    """Applying a file failed (connection or SQL error)."""


class SetupError(Exception):
    """Invalid arguments or missing prerequisites."""


@dataclass(frozen=True)
class Target:
    """Database to apply to, parsed from a postgres:// or postgresql:// URL."""

    url: str
    host: str
    port: str
    dbname: str
    user: str
    password: str
    params: dict[str, str]

    @classmethod
    def from_url(cls, url: str) -> "Target":
        parts = urlsplit(url.strip())
        if parts.scheme not in ("postgres", "postgresql"):
            raise SetupError(f"{URL_ENV_VAR} must start with postgresql:// (got scheme '{parts.scheme or 'none'}')")
        try:
            port = str(parts.port or "")
        except ValueError as exc:
            raise SetupError(f"{URL_ENV_VAR} has an invalid port: {exc}") from exc
        return cls(
            url=url.strip(),
            host=unquote(parts.hostname or ""),
            port=port,
            dbname=unquote(parts.path.lstrip("/")),
            user=unquote(parts.username or ""),
            password=unquote(parts.password or ""),
            params=dict(parse_qsl(parts.query)),
        )

    def describe(self) -> str:
        """Target without credentials, for log output."""
        host = self.host or self.params.get("host", "") or "localhost"
        port = self.port or self.params.get("port", "") or "5432"
        dbname = self.dbname or self.params.get("dbname", "") or "(default)"
        user = self.user or self.params.get("user", "") or "(default)"
        return f"{dbname} on {host}:{port} as {user}"

    def psql_env(self) -> dict[str, str]:
        """libpq environment variables, so the password never appears in argv."""
        env: dict[str, str] = {}
        for key, value in self.params.items():
            env_name = _QUERY_TO_PGENV.get(key)
            if env_name is None:
                print(f"warning: ignoring unsupported connection parameter '{key}' for psql", file=sys.stderr)
                continue
            env[env_name] = value
        for value, env_name in (
            (self.host, "PGHOST"),
            (self.port, "PGPORT"),
            (self.dbname, "PGDATABASE"),
            (self.user, "PGUSER"),
            (self.password, "PGPASSWORD"),
        ):
            if value:
                env[env_name] = value
        return env


def _driver_name() -> str:
    """Name of the client used to run SQL: psycopg, psycopg2 or psql."""
    try:
        import psycopg  # noqa: F401

        return "psycopg"
    except ImportError:
        pass
    try:
        import psycopg2  # noqa: F401

        return "psycopg2"
    except ImportError:
        pass
    if shutil.which("psql"):
        return "psql"
    raise SetupError(
        "no Postgres client found: install psycopg (pip install 'psycopg[binary]') or the psql command line client"
    )


def _apply_with_psycopg(target: Target, sql: str) -> None:
    import psycopg

    try:
        with psycopg.connect(target.url, autocommit=True) as conn:
            conn.add_notice_handler(lambda diag: print(f"  {diag.severity}: {diag.message_primary}"))
            # No parameters: sent as a simple query, so multiple statements work.
            conn.execute(sql)
    except psycopg.Error as exc:
        raise ApplyError(str(exc).strip()) from exc


def _apply_with_psycopg2(target: Target, sql: str) -> None:
    import psycopg2

    try:
        conn = psycopg2.connect(target.url)
    except psycopg2.Error as exc:
        raise ApplyError(str(exc).strip()) from exc
    try:
        conn.autocommit = True
        with conn.cursor() as cur:
            cur.execute(sql)
    except psycopg2.Error as exc:
        raise ApplyError(str(exc).strip()) from exc
    finally:
        for notice in conn.notices:
            print(f"  {notice.strip()}")
        conn.close()


def _apply_with_psql(target: Target, path: Path) -> None:
    env = os.environ.copy()
    env.pop(URL_ENV_VAR, None)
    env.update(target.psql_env())
    cmd = ["psql", "-X", "-q", "-v", "ON_ERROR_STOP=1", "-f", str(path)]
    # Fixed argv (no shell); the only variable part is a repository SQL file path.
    result = subprocess.run(cmd, env=env, check=False)  # noqa: S603
    if result.returncode != 0:
        raise ApplyError(f"psql exited with code {result.returncode}")


def apply_file(target: Target, path: Path, driver: str) -> None:
    """Runs one SQL file against the target."""
    if driver == "psql":
        _apply_with_psql(target, path)
        return
    sql = path.read_text(encoding="utf-8")
    if _PSQL_META_COMMAND.search(sql):
        raise SetupError(f"{path.name} contains psql meta-commands; run it with psql or pick another file")
    if driver == "psycopg":
        _apply_with_psycopg(target, sql)
    else:
        _apply_with_psycopg2(target, sql)


def resolve_files(files: Sequence[str], all_migrations: bool) -> list[Path]:
    """Files to apply, in order."""
    if all_migrations and files:
        raise SetupError("pass either --migrations or explicit files, not both")
    if all_migrations:
        paths = sorted(MIGRATIONS_DIR.glob("*.sql"))
        if not paths:
            raise SetupError(f"no .sql files in {MIGRATIONS_DIR}")
        return paths
    if not files:
        return [DEFAULT_SCHEMA]
    paths = []
    for name in files:
        path = Path(name)
        if not path.is_file() and not path.is_absolute() and (SUPABASE_DIR / name).is_file():
            path = SUPABASE_DIR / name
        if not path.is_file():
            raise SetupError(f"SQL file not found: {name}")
        paths.append(path.resolve())
    return paths


def parse_args(argv: Sequence[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=f"Apply Starpi SQL files to the database in ${URL_ENV_VAR}.",
    )
    parser.add_argument(
        "files",
        nargs="*",
        help="SQL files to apply in order (default: full_schema.sql). "
        "Relative paths are also looked up in backend/supabase/.",
    )
    parser.add_argument(
        "--migrations",
        action="store_true",
        help="apply every file in backend/supabase/migrations/ in file-name order",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="print the files and target without connecting",
    )
    return parser.parse_args(argv)


def main(argv: Sequence[str] | None = None) -> int:
    args = parse_args(argv)
    try:
        paths = resolve_files(args.files, args.migrations)
        url = os.environ.get(URL_ENV_VAR, "").strip()
        target = Target.from_url(url) if url else None
        if args.dry_run:
            print(f"target: {target.describe() if target else f'(set {URL_ENV_VAR})'}")
            for path in paths:
                print(f"would apply: {path}")
            return 0
        if target is None:
            raise SetupError(
                f"{URL_ENV_VAR} is not set. Use the Postgres connection string of the project "
                "(Supabase dashboard: Connect), e.g. "
                "postgresql://postgres:<password>@db.<project-ref>.supabase.co:5432/postgres"
            )
        driver = _driver_name()
    except SetupError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2

    print(f"target: {target.describe()} (via {driver})")
    for path in paths:
        print(f"applying {path.name} ...")
        try:
            apply_file(target, path, driver)
        except SetupError as exc:
            print(f"error: {exc}", file=sys.stderr)
            return 2
        except ApplyError as exc:
            print(
                f"error: {path.name} failed:\n{exc}\n"
                "The Starpi SQL files run in a single transaction, so nothing from this file was committed.",
                file=sys.stderr,
            )
            return 1
        print(f"applied {path.name}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
