import os
import sys
import tempfile
from pathlib import Path

import pytest

# Isolated database and upload folder per test session — never touches atliq.db.
_tmp = tempfile.mkdtemp(prefix="atliq-test-")
os.environ["ATLIQ_DB"] = str(Path(_tmp) / "test.db")
os.environ["ATLIQ_UPLOADS"] = str(Path(_tmp) / "uploads")
os.environ.pop("ANTHROPIC_API_KEY", None)  # tests exercise the free rules engine
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app import db  # noqa: E402
from app.pipeline import run as run_mod  # noqa: E402

run_mod.STEP_DELAY = 0

DATASET = Path(__file__).resolve().parents[2] / "Dataset"
INCOMING = DATASET / "incoming"
SIGNED = DATASET / "signed_contracts"


@pytest.fixture(autouse=True)
def fresh_db():
    db.UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
    db.reset()
    yield


@pytest.fixture
def client():
    from fastapi.testclient import TestClient

    from app.main import app

    with TestClient(app) as c:
        yield c


def as_user(user: str) -> dict:
    return {"X-User": user}
