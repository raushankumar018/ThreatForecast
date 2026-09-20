from pathlib import Path
import asyncio
import shutil
import uuid

from fastapi import (
    FastAPI,HTTPException,WebSocket,WebSocketDisconnect,UploadFile,File,Request,
)
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

from .config import (
    THRESHOLD,
    N_FEATURES,
    HISTORY_STATES,
    STATE_SECONDS,
)
from .services.runtime import Runtime
from .services.mitre import Mitre
from .services.explain import Shap


# ============================================================
# APPLICATION
# ============================================================

app = FastAPI(
    title="PREVENT-X Production API",
    version="1.2.0",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# ============================================================
# GLOBAL RUNTIME
# ============================================================

runtime = Runtime()
mitre = Mitre()
shap = None


# ============================================================
# FILE / PCAP CONFIGURATION
# ============================================================

UPLOAD_DIR = (
    Path(__file__).resolve().parents[1]
    / "runtime"
    / "uploads"
)

UPLOAD_DIR.mkdir(
    parents=True,
    exist_ok=True,
)

ALLOWED_PCAP_SUFFIXES = {
    ".pcap",
    ".pcapng",
    ".cap",
}

# Your file is approximately 8.8 GB.
# Allow up to 16 GiB for production.
MAX_UPLOAD_BYTES = 16 * 1024 * 1024 * 1024

CHUNK_SIZE = 8 * 1024 * 1024


# ============================================================
# REQUEST MODELS
# ============================================================

class StartReq(BaseModel):
    interface: str = ""


class ReplayReq(BaseModel):
    path: str
    speed: float = Field(
        1.0,
        gt=0,
    )


class ExplainReq(BaseModel):
    horizon_seconds: int = 10
    max_evals: int = 600


# ============================================================
# STARTUP
# ============================================================

@app.on_event("startup")
async def startup():

    global shap

    try:

        await runtime.startup()

        shap = Shap(
            runtime.model
        )

        print(
            "[startup] PREVENT-X model loaded",
            flush=True,
        )

    except Exception as e:

        print(
            f"[startup-error] "
            f"{type(e).__name__}: {e}",
            flush=True,
        )


# ============================================================
# SHUTDOWN
# ============================================================

@app.on_event("shutdown")
async def shutdown():

    await runtime.stop()


# ============================================================
# HEALTH
# ============================================================

@app.get("/api/health")
def health():

    return {
        "status":
            "ok"
            if runtime.model.loaded
            else "degraded",

        "model_loaded":
            runtime.model.loaded,

        "scaler_loaded":
            runtime.model.scaler is not None,

        "threshold":
            runtime.model.threshold,

        "feature_count":
            N_FEATURES,

        "history_states":
            HISTORY_STATES,

        "state_seconds":
            STATE_SECONDS,

        "max_upload_gb":
            round(
                MAX_UPLOAD_BYTES
                / (1024 ** 3),
                2,
            ),
    }


# ============================================================
# STATUS
# ============================================================

@app.get("/api/status")
def status():

    return runtime.status()


# ============================================================
# LATEST FORECAST
# ============================================================

@app.get("/api/forecast/latest")
def latest():

    if runtime.history:

        return runtime.history[-1]

    return {
        "status": "not_ready"
    }


# ============================================================
# FORECAST HISTORY
# ============================================================

@app.get("/api/forecast/history")
def hist():

    return {
        "items":
            list(runtime.history)
    }


# ============================================================
# MITRE ATT&CK
# ============================================================

@app.get("/api/mitre/candidates")
def mitre_candidates():

    latest_item = (
        runtime.history[-1]
        if runtime.history
        else None
    )

    state = (
        latest_item.get("latest_state")
        if latest_item
        else None
    )

    return {
        "full_stix_loaded":
            mitre.full,

        "candidates":
            mitre.candidates(state),
    }


# ============================================================
# LIVE CAPTURE START
# ============================================================

@app.post("/api/control/start")
async def start(req: StartReq):

    if not runtime.model.loaded:

        raise HTTPException(
            status_code=503,
            detail=(
                "Production artifacts are not loaded. "
                "Put them in artifacts/."
            ),
        )

    try:

        await runtime.live(
            req.interface
        )

        return runtime.status()

    except Exception as e:

        raise HTTPException(
            status_code=500,
            detail=str(e),
        )


# ============================================================
# STOP
# ============================================================

@app.post("/api/control/stop")
async def stop():

    await runtime.stop()

    return runtime.status()


# ============================================================
# SERVER-SIDE PCAP REPLAY
# ============================================================

@app.post("/api/control/replay")
async def replay(req: ReplayReq):

    if not runtime.model.loaded:

        raise HTTPException(
            status_code=503,
            detail="Production artifacts are not loaded.",
        )

    path = (
        Path(req.path)
        .expanduser()
        .resolve()
    )

    if not path.is_file():

        raise HTTPException(
            status_code=400,
            detail=(
                f"PCAP file not found: {path}"
            ),
        )

    if (
        path.suffix.lower()
        not in ALLOWED_PCAP_SUFFIXES
    ):

        raise HTTPException(
            status_code=400,
            detail=(
                "Supported files: "
                ".pcap, .pcapng, .cap"
            ),
        )

    try:

        await runtime.replay_pcap(
            str(path),
            req.speed,
        )

        return runtime.status()

    except Exception as e:

        raise HTTPException(
            status_code=400,
            detail=str(e),
        )


# ============================================================
# MULTIPART PCAP UPLOAD
# ============================================================

@app.post(
    "/api/control/replay-upload"
)
async def replay_upload(
    file: UploadFile = File(...),
    speed: float = 1.0,
):

    return await _save_and_replay_upload(
        file.filename or "",
        file,
        speed,
    )


async def _save_and_replay_upload(
    filename,
    file_obj,
    speed,
):

    if not runtime.model.loaded:

        raise HTTPException(
            status_code=503,
            detail=(
                "Production artifacts are not loaded."
            ),
        )

    if speed <= 0:

        raise HTTPException(
            status_code=400,
            detail=(
                "Replay speed must be greater than 0."
            ),
        )

    suffix = (
        Path(filename)
        .suffix
        .lower()
    )

    if suffix not in ALLOWED_PCAP_SUFFIXES:

        raise HTTPException(
            status_code=400,
            detail=(
                "Supported files: "
                ".pcap, .pcapng, .cap"
            ),
        )

    safe_name = (
        f"{uuid.uuid4().hex}"
        f"{suffix}"
    )

    destination = (
        UPLOAD_DIR
        / safe_name
    )

    total = 0

    try:

        with destination.open(
            "wb"
        ) as out:

            while True:

                chunk = await file_obj.read(
                    CHUNK_SIZE
                )

                if not chunk:
                    break

                total += len(chunk)

                if total > MAX_UPLOAD_BYTES:

                    raise HTTPException(
                        status_code=413,
                        detail=(
                            "PCAP upload exceeds "
                            f"the configured "
                            f"{MAX_UPLOAD_BYTES / (1024 ** 3):.1f} GiB limit."
                        ),
                    )

                out.write(chunk)

    except HTTPException:

        destination.unlink(
            missing_ok=True
        )

        raise

    except Exception as e:

        destination.unlink(
            missing_ok=True
        )

        raise HTTPException(
            status_code=500,
            detail=f"Upload failed: {e}",
        )

    finally:

        close = getattr(
            file_obj,
            "close",
            None,
        )

        if close is not None:

            result = close()

            if hasattr(
                result,
                "__await__",
            ):

                await result

    try:

        await runtime.replay_pcap(
            str(destination),
            speed,
        )

    except Exception as e:

        destination.unlink(
            missing_ok=True
        )

        raise HTTPException(
            status_code=400,
            detail=str(e),
        )

    return {
        **runtime.status(),

        "uploaded_file":
            filename,

        "stored_file":
            str(destination),

        "size_bytes":
            total,

        "size_gib":
            round(
                total / (1024 ** 3),
                3,
            ),
    }


# ============================================================
# LARGE RAW PCAP UPLOAD
# ============================================================
#
# IMPORTANT:
# The Request annotation is mandatory.
#
# Without:
#     request: Request
#
# FastAPI interprets "request" as a normal parameter and
# returns HTTP 422.
#
# This endpoint is intentionally used for the 8.8 GB PCAP.
# ============================================================

@app.post(
    "/api/control/replay-upload-raw"
)
async def replay_upload_raw(
    request: Request,
    speed: float = 1.0,
):

    if not runtime.model.loaded:

        raise HTTPException(
            status_code=503,
            detail=(
                "Production artifacts are not loaded."
            ),
        )

    if speed <= 0:

        raise HTTPException(
            status_code=400,
            detail=(
                "Replay speed must be greater than 0."
            ),
        )

    filename = (
        request.headers.get(
            "x-filename",
            "capture.pcap",
        )
    )

    suffix = (
        Path(filename)
        .suffix
        .lower()
    )

    if suffix not in ALLOWED_PCAP_SUFFIXES:

        raise HTTPException(
            status_code=400,
            detail=(
                "Supported files: "
                ".pcap, .pcapng, .cap"
            ),
        )

    safe_name = (
        f"{uuid.uuid4().hex}"
        f"{suffix}"
    )

    destination = (
        UPLOAD_DIR
        / safe_name
    )

    total = 0

    print(
        f"[upload] Starting large PCAP upload: "
        f"{filename}",
        flush=True,
    )

    try:

        with destination.open(
            "wb"
        ) as out:

            async for chunk in request.stream():

                if not chunk:
                    continue

                total += len(chunk)

                if total > MAX_UPLOAD_BYTES:

                    raise HTTPException(
                        status_code=413,
                        detail=(
                            "PCAP upload exceeds "
                            f"the configured "
                            f"{MAX_UPLOAD_BYTES / (1024 ** 3):.1f} GiB limit."
                        ),
                    )

                out.write(chunk)

    except HTTPException:

        destination.unlink(
            missing_ok=True
        )

        raise

    except Exception as e:

        destination.unlink(
            missing_ok=True
        )

        raise HTTPException(
            status_code=500,
            detail=(
                f"Upload failed: "
                f"{type(e).__name__}: {e}"
            ),
        )

    print(
        f"[upload] Completed: "
        f"{total / (1024 ** 3):.3f} GiB",
        flush=True,
    )

    # --------------------------------------------------------
    # Start replay AFTER the complete file is saved.
    # --------------------------------------------------------

    try:

        await runtime.replay_pcap(
            str(destination),
            speed,
        )

    except Exception as e:

        destination.unlink(
            missing_ok=True
        )

        raise HTTPException(
            status_code=400,
            detail=str(e),
        )

    return {
        **runtime.status(),

        "uploaded_file":
            filename,

        "stored_file":
            str(destination),

        "size_bytes":
            total,

        "size_gib":
            round(
                total / (1024 ** 3),
                3,
            ),

        "message":
            "PCAP uploaded and replay started.",
    }


# ============================================================
# SHAP EXPLANATION
# ============================================================

@app.post(
    "/api/explain"
)
def explain(req: ExplainReq):

    if shap is None:

        raise HTTPException(
            status_code=503,
            detail="Model not loaded.",
        )

    matrix = (
        runtime.engine.matrix()
    )

    if matrix is None:

        raise HTTPException(
            status_code=409,
            detail=(
                "Need five complete "
                "10-second states before "
                "SHAP is available."
            ),
        )

    try:

        return shap.explain(
            matrix,
            req.horizon_seconds,
            req.max_evals,
        )

    except Exception as e:

        raise HTTPException(
            status_code=500,
            detail=str(e),
        )


# ============================================================
# WEBSOCKET
# ============================================================
@app.websocket("/ws/live")
async def ws(
    websocket: WebSocket
):

    await websocket.accept()

    print(
        "[WS] FRONTEND CONNECTED",
        flush=True
    )

    # Larger queue for high-volume packet traffic
    q = asyncio.Queue(
        maxsize=1000
    )

    runtime.subs.add(q)

    print(
        f"[WS] SUBSCRIBER COUNT: "
        f"{len(runtime.subs)}",
        flush=True
    )

    sent_packets = 0
    sent_forecasts = 0

    try:

        while True:

            item = await q.get()

            event_type = item.get(
                "event_type"
            )

            await websocket.send_json(
                item
            )

            if event_type == "packet":

                sent_packets += 1

                if (
                    sent_packets == 1
                    or sent_packets % 100 == 0
                ):

                    print(
                        f"[WS] PACKETS SENT: "
                        f"{sent_packets}",
                        flush=True
                    )

            elif event_type == "forecast":

                sent_forecasts += 1

                print(
                    f"[WS] FORECAST SENT: "
                    f"{sent_forecasts}",
                    flush=True
                )

    except WebSocketDisconnect:

        print(
            "[WS] FRONTEND DISCONNECTED",
            flush=True
        )

    except Exception as e:

        print(
            f"[WS ERROR] "
            f"{type(e).__name__}: {e}",
            flush=True
        )

    finally:

        runtime.subs.discard(
            q
        )

        print(
            f"[WS] SUBSCRIBER REMOVED. "
            f"REMAINING: {len(runtime.subs)}",
            flush=True
        )