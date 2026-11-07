"""Database provider abstraction.

The application never talks to a concrete engine directly. It asks the
`DatabaseProvider` for a session. This is the seam that lets the same code run
on SQLite (local / gateway) and PostgreSQL (cloud) *without pretending the two
are identical*: dialect specific behaviour is declared here instead of leaking
into routers.

We deliberately do not claim "swap the URL and everything works". `capabilities`
exposes what the current backend actually supports so the UI and the sync layer
can degrade gracefully.
"""

from __future__ import annotations

from contextlib import contextmanager
from typing import Iterator

from sqlalchemy import create_engine, event, text
from sqlalchemy.engine import Engine
from sqlalchemy.orm import DeclarativeBase, Session, sessionmaker

from .config import settings


class Base(DeclarativeBase):
    pass


class DatabaseProvider:
    """Base contract for a database backend."""

    dialect: str = "unknown"

    def __init__(self, url: str) -> None:
        self.url = url
        self._engine: Engine | None = None
        self._session_factory: sessionmaker[Session] | None = None

    # -- lifecycle ---------------------------------------------------------
    def create(self) -> Engine:
        raise NotImplementedError

    @property
    def engine(self) -> Engine:
        if self._engine is None:
            self._engine = self.create()
            Base.metadata.create_all(self._engine)
        return self._engine

    @property
    def session_factory(self) -> sessionmaker[Session]:
        if self._session_factory is None:
            self._session_factory = sessionmaker(
                bind=self.engine, autoflush=False, expire_on_commit=False
            )
        return self._session_factory

    # -- access ------------------------------------------------------------
    def session(self) -> Session:
        return self.session_factory()

    @contextmanager
    def transaction(self) -> Iterator[Session]:
        s = self.session()
        try:
            yield s
            s.commit()
        except Exception:
            s.rollback()
            raise
        finally:
            s.close()

    # -- introspection -----------------------------------------------------
    def capabilities(self) -> dict:
        return {
            "dialect": self.dialect,
            "concurrent_writers": False,
            "json_query": False,
            "full_text_search": False,
            "recommended_mode": "local",
        }

    def health(self) -> dict:
        try:
            with self.engine.connect() as conn:
                conn.execute(text("SELECT 1"))
            return {"ok": True, "dialect": self.dialect}
        except Exception as exc:  # pragma: no cover - defensive
            return {"ok": False, "dialect": self.dialect, "error": str(exc)}


class SQLiteProvider(DatabaseProvider):
    """SQLite: perfect for a single device or a gateway with an API in front.

    Important architectural note: in gateway mode every client talks to the API,
    never to this file directly. Multiple processes writing the same SQLite file
    over a network share is explicitly unsupported.
    """

    dialect = "sqlite"

    def create(self) -> Engine:
        engine = create_engine(
            self.url,
            future=True,
            connect_args={"check_same_thread": False, "timeout": 30},
            pool_pre_ping=True,
        )

        @event.listens_for(engine, "connect")
        def _set_sqlite_pragma(dbapi_conn, _record):  # noqa: ANN001
            cur = dbapi_conn.cursor()
            cur.execute("PRAGMA foreign_keys=ON")
            cur.execute("PRAGMA journal_mode=WAL")
            cur.execute("PRAGMA synchronous=NORMAL")
            cur.execute("PRAGMA busy_timeout=8000")
            cur.close()

        return engine

    def capabilities(self) -> dict:
        return {
            "dialect": "sqlite",
            "concurrent_writers": False,
            "json_query": True,
            "full_text_search": True,
            "recommended_mode": "local/gateway",
            "note": "Write concurrency is serialised; always put the API in front.",
        }


class PostgresProvider(DatabaseProvider):
    """PostgreSQL: the cloud profile. Requires psycopg driver."""

    dialect = "postgresql"

    def create(self) -> Engine:
        return create_engine(
            self.url,
            future=True,
            pool_pre_ping=True,
            pool_size=10,
            max_overflow=20,
        )

    def capabilities(self) -> dict:
        return {
            "dialect": "postgresql",
            "concurrent_writers": True,
            "json_query": True,
            "full_text_search": True,
            "recommended_mode": "cloud",
        }


def build_provider(url: str | None = None) -> DatabaseProvider:
    url = url or settings.resolved_database_url
    if url.startswith("sqlite"):
        return SQLiteProvider(url)
    if url.startswith("postgresql") or url.startswith("postgres"):
        return PostgresProvider(url)
    raise ValueError(f"Unsupported database url: {url}")


provider = build_provider()


def get_db() -> Iterator[Session]:
    """FastAPI dependency."""
    session = provider.session()
    try:
        yield session
    finally:
        session.close()
