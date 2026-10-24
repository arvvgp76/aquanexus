# AquaNexus — website + river-trash detection API

One folder, one command. The FastAPI backend serves the website **and** the detection API
from the same address, so there is nothing to wire up and no CORS to fight.

```
aquanexus/
├─ backend/     FastAPI + YOLO (app.py, requirements.txt, .env)
├─ frontend/
│  ├─ site/                     main AquaNexus website  → http://localhost:8000/
│  └─ pollution-report-site/    report-pollution page   → http://localhost:8000/report/
├─ run.bat / run.sh             start everything
└─ .vscode/                     F5 launch config
```

## Run it

**Option A – one command**
- Windows: double-click `run.bat` (or run it in the VS Code terminal)
- macOS/Linux: `./run.sh`

**Option B – VS Code**
1. `File → Open Folder…` → this `aquanexus` folder
2. Terminal → `cd backend`, then `python -m venv .venv`, `.venv\Scripts\activate`, `pip install -r requirements.txt` (once)
3. Press **F5** (“AquaNexus (website + API on :8000)”)

Then open:
- http://localhost:8000/ — main website (has a new **Report pollution** link in the menu)
- http://localhost:8000/report/ — upload a photo → the model runs → detected items are shown on the photo
- http://localhost:8000/docs — interactive API docs

The first start downloads `best.pt` from Hugging Face (needs internet and the values in `backend/.env`).

## What was connected
- `/report/` form: choosing a photo calls `POST /api/analyze`; the annotated photo and a list of detected items appear, and “What do you see?” is pre-set to *Plastic and solid waste* when something is found (unless you already changed it).
- “Submit report” now posts to `POST /api/reports`, which saves the photo to `backend/data/report_photos/` and the record to `backend/data/reports.jsonl` (`GET /api/reports` lists them).
- Your original endpoints `/detect`, `/detect/image` and `/health` are unchanged.
- If the model can't load (no internet, wrong repo id), the website still runs and detection reports “unavailable”; the reason is shown at `/health`.

## Card donations (optional)
The UPI QR works with no backend. Card payments need the Node/Razorpay server:
```
cd frontend/site/server
copy .env.example .env     (add your Razorpay keys)
npm start                  → http://localhost:8080  (open the site from this address for card donations)
```

## Security notes
- `backend/.env` holds your Hugging Face token. It is git-ignored; don't share the folder/zip with it inside.
- The backend serves only the two `index.html` files, never the folders around them (the donation server's `.env` lives there).
