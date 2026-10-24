import base64
import io
import json
import os
import threading
import uuid
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from pathlib import Path

from dotenv import load_dotenv
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.concurrency import run_in_threadpool
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, StreamingResponse
from huggingface_hub import hf_hub_download
from PIL import Image, UnidentifiedImageError
from ultralytics import YOLO

BASE_DIR = Path(__file__).resolve().parent
load_dotenv(BASE_DIR / ".env")

HF_TOKEN = os.getenv("HF_TOKEN", "").strip()
HF_REPO_ID = os.getenv("HF_REPO_ID", "").strip()

# --- Frontend + storage locations (the project is laid out as backend/ + frontend/) ---
FRONTEND_DIR = BASE_DIR.parent / "frontend"
MAIN_SITE = FRONTEND_DIR / "site" / "index.html"
REPORT_SITE = FRONTEND_DIR / "pollution-report-site" / "index.html"
DATA_DIR = BASE_DIR / "data"
REPORT_PHOTOS_DIR = DATA_DIR / "report_photos"
REPORTS_FILE = DATA_DIR / "reports.jsonl"
_reports_lock = threading.Lock()

model = None
model_error = None


def load_model():
    if not HF_REPO_ID:
        raise RuntimeError("HF_REPO_ID is missing from your .env file.")

    model_path = hf_hub_download(
        repo_id=HF_REPO_ID,
        filename="best.pt",
        token=HF_TOKEN or None,
    )
    return YOLO(model_path)


@asynccontextmanager
async def lifespan(app: FastAPI):
    global model, model_error

    # A failed model download must not take the whole website down:
    # the pages are still served and the detection endpoints answer 503.
    try:
        model = await run_in_threadpool(load_model)
        model_error = None
        print("River Trash Detection model loaded successfully!")
    except Exception as exc:  # noqa: BLE001
        model = None
        model_error = str(exc)
        print(f"WARNING: model could not be loaded: {exc}")
        print("The website will still run, but photo detection is unavailable.")

    yield

    model = None


app = FastAPI(
    title="River Trash Detection API",
    description="Detects river trash using a trained YOLO model.",
    version="1.1.0",
    lifespan=lifespan,
)

# The website is served by this same app (same origin), so CORS is only needed
# if you open the frontend from another dev server (e.g. VS Code Live Server on :5500).
# Restrict this list to your real frontend origin before deployment.
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:3000",
        "http://127.0.0.1:3000",
        "http://localhost:5173",
        "http://127.0.0.1:5173",
        "http://localhost:5500",
        "http://127.0.0.1:5500",
        "http://localhost:8000",
        "http://127.0.0.1:8000",
        "http://localhost:8080",
        "http://127.0.0.1:8080",
    ],
    allow_credentials=False,
    allow_methods=["GET", "POST"],
    allow_headers=["*"],
)

MAX_IMAGE_BYTES = 10 * 1024 * 1024
ALLOWED_TYPES = {"image/jpeg", "image/png", "image/webp"}
ALLOWED_REPORT_TYPES = {"plastic", "drain", "chemical", "other"}


# ----------------------------------------------------------------------------
# Websites (served from ../frontend). Only the two index.html files are exposed,
# never the folders around them (the donation server's .env lives next to them).
# ----------------------------------------------------------------------------
@app.get("/", include_in_schema=False)
def main_site():
    if not MAIN_SITE.is_file():
        raise HTTPException(status_code=404, detail="frontend/site/index.html not found.")
    return FileResponse(MAIN_SITE, media_type="text/html")


@app.get("/report", include_in_schema=False)
@app.get("/report/", include_in_schema=False)
def report_site():
    if not REPORT_SITE.is_file():
        raise HTTPException(
            status_code=404,
            detail="frontend/pollution-report-site/index.html not found.",
        )
    return FileResponse(REPORT_SITE, media_type="text/html")


# ----------------------------------------------------------------------------
# API
# ----------------------------------------------------------------------------
@app.get("/api")
def api_home():
    return {
        "message": "River Trash Detection API is running",
        "docs": "/docs",
    }


@app.get("/health")
@app.get("/api/health")
def health():
    return {
        "status": "ok",
        "model_loaded": model is not None,
        "model_error": model_error,
    }


def require_model():
    if model is None:
        raise HTTPException(
            status_code=503,
            detail="Model is not loaded."
            + (f" ({model_error})" if model_error else ""),
        )


async def read_image(file: UploadFile):
    if file.content_type not in ALLOWED_TYPES:
        raise HTTPException(
            status_code=415,
            detail="Upload a JPEG, PNG, or WebP image.",
        )

    content = await file.read(MAX_IMAGE_BYTES + 1)

    if not content:
        raise HTTPException(status_code=400, detail="The uploaded file is empty.")

    if len(content) > MAX_IMAGE_BYTES:
        raise HTTPException(
            status_code=413,
            detail="Image must be 10 MB or smaller.",
        )

    try:
        image = Image.open(io.BytesIO(content))
        image.load()
        image = image.convert("RGB")
    except (UnidentifiedImageError, OSError):
        raise HTTPException(
            status_code=400,
            detail="The uploaded file is not a valid image.",
        )

    return image


async def predict(image):
    try:
        results = await run_in_threadpool(
            lambda: model.predict(source=image, verbose=False)
        )
    except Exception:
        raise HTTPException(
            status_code=500,
            detail="Detection failed. Check the server terminal for details.",
        )
    return results[0]


def extract_detections(result):
    detections = []
    for box in result.boxes:
        class_id = int(box.cls[0].item())
        detections.append({
            "class_id": class_id,
            "class_name": result.names[class_id],
            "confidence": round(float(box.conf[0].item()), 4),
            "bbox_xyxy": [
                round(float(value), 2)
                for value in box.xyxy[0].tolist()
            ],
        })
    return detections


def annotated_jpeg_bytes(result) -> bytes:
    annotated = result.plot()
    output = Image.fromarray(annotated[:, :, ::-1].copy())
    buffer = io.BytesIO()
    output.save(buffer, format="JPEG", quality=90)
    return buffer.getvalue()


def count_by_class(detections):
    counts = {}
    for item in detections:
        counts[item["class_name"]] = counts.get(item["class_name"], 0) + 1
    return counts


@app.post("/detect")
async def detect(file: UploadFile = File(...)):
    require_model()

    image = await read_image(file)
    result = await predict(image)
    detections = extract_detections(result)

    return {
        "filename": file.filename,
        "image_width": image.width,
        "image_height": image.height,
        "detection_count": len(detections),
        "detections": detections,
    }


@app.post("/detect/image")
async def detect_image(file: UploadFile = File(...)):
    require_model()

    image = await read_image(file)
    result = await predict(image)

    try:
        data = annotated_jpeg_bytes(result)
    except Exception:
        raise HTTPException(
            status_code=500,
            detail="Image annotation failed. Check the server terminal.",
        )

    return StreamingResponse(
        io.BytesIO(data),
        media_type="image/jpeg",
        headers={"Content-Disposition": 'inline; filename="detected.jpg"'},
    )


@app.post("/api/analyze")
async def analyze(file: UploadFile = File(...)):
    """One inference -> detections AND the annotated image (base64 data URL).

    Used by the website's report form to preview what the model found.
    """
    require_model()

    image = await read_image(file)
    result = await predict(image)
    detections = extract_detections(result)

    try:
        data = annotated_jpeg_bytes(result)
    except Exception:
        raise HTTPException(
            status_code=500,
            detail="Image annotation failed. Check the server terminal.",
        )

    return {
        "filename": file.filename,
        "image_width": image.width,
        "image_height": image.height,
        "detection_count": len(detections),
        "summary": count_by_class(detections),
        "detections": detections,
        "annotated_image": "data:image/jpeg;base64,"
        + base64.b64encode(data).decode("ascii"),
    }


@app.post("/api/reports")
async def create_report(
    photo: UploadFile = File(...),
    location: str = Form(...),
    report_type: str = Form("other", alias="type"),
    note: str = Form(""),
    worker: str = Form(""),
    lat: float | None = Form(None),
    lng: float | None = Form(None),
):
    """Receives the website's "Submit report" form and stores it locally.

    Photos go to backend/data/report_photos/, records to backend/data/reports.jsonl.
    If the model is loaded, the photo is also run through it and the result is stored.
    """
    location = location.strip()[:200]
    if not location:
        raise HTTPException(status_code=422, detail="Location is required.")

    report_type = report_type if report_type in ALLOWED_REPORT_TYPES else "other"
    image = await read_image(photo)

    detections = []
    if model is not None:
        result = await predict(image)
        detections = extract_detections(result)

    report_id = uuid.uuid4().hex[:12]
    photo_name = f"{report_id}.jpg"

    def save_photo():
        REPORT_PHOTOS_DIR.mkdir(parents=True, exist_ok=True)
        image.save(REPORT_PHOTOS_DIR / photo_name, format="JPEG", quality=90)

    await run_in_threadpool(save_photo)

    record = {
        "id": report_id,
        "created_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "location": location,
        "type": report_type,
        "note": note.strip()[:1000],
        "worker": worker.strip()[:64],
        "lat": lat,
        "lng": lng,
        "photo": photo_name,
        "detection_count": len(detections),
        "summary": count_by_class(detections),
    }

    def append_record():
        DATA_DIR.mkdir(parents=True, exist_ok=True)
        with _reports_lock:
            with open(REPORTS_FILE, "a", encoding="utf-8") as fh:
                fh.write(json.dumps(record, ensure_ascii=False) + "\n")

    await run_in_threadpool(append_record)

    return {"status": "received", **record}


@app.get("/api/reports")
def list_reports(limit: int = 50):
    """Most recent stored reports (newest first)."""
    limit = max(1, min(limit, 200))
    if not REPORTS_FILE.is_file():
        return {"count": 0, "reports": []}

    with _reports_lock:
        lines = REPORTS_FILE.read_text(encoding="utf-8").splitlines()

    reports = []
    for line in reversed(lines):
        if len(reports) >= limit:
            break
        try:
            reports.append(json.loads(line))
        except json.JSONDecodeError:
            continue

    return {"count": len(reports), "reports": reports}
