import os
import asyncio
from datetime import date
from contextlib import asynccontextmanager
from pathlib import Path
from uuid import uuid4

from fastapi import FastAPI, HTTPException, BackgroundTasks, Header
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse, JSONResponse
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from dotenv import load_dotenv

load_dotenv()

from .config import AUDIO_DIR, STATIC_DIR
from .database import init_db, get_session, Broadcast, NewsItem
from .collector import fetch_news
from .script_gen import generate_script
from .tts import synthesize
from .scheduler import start_scheduler

AUDIO_DIR.mkdir(parents=True, exist_ok=True)

_generation_lock = asyncio.Lock()
_generation_status: dict[str, str] = {}
_chat_jobs: dict[str, dict] = {}


@asynccontextmanager
async def lifespan(app: FastAPI):
    init_db()
    start_scheduler(run_daily_broadcast)
    yield


app = FastAPI(title="Daily News Radio", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

app.mount("/audio",  StaticFiles(directory=str(AUDIO_DIR)),  name="audio")
app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")


# ─── 共通ヘルパー ─────────────────────────────────────────────────────────
def _resolve_key(header_key: str | None) -> str:
    return header_key or os.environ.get("ANTHROPIC_API_KEY", "")

def _resolve_openai_key(header_key: str | None) -> str:
    return header_key or os.environ.get("OPENAI_API_KEY", "")


# ─── デイリー放送 ─────────────────────────────────────────────────────────
async def run_daily_broadcast(
    target_date: str | None = None,
    api_key: str | None = None,
    openai_key: str | None = None,
    tts_provider: str | None = None,
):
    date_str = target_date or date.today().isoformat()
    key = _resolve_key(api_key)

    async with _generation_lock:
        if _generation_status.get(date_str) == "running":
            return
        _generation_status[date_str] = "running"

    try:
        with get_session() as session:
            existing = session.query(Broadcast).filter_by(date=date_str).first()
            if existing and existing.is_ready:
                _generation_status[date_str] = "done"
                return
            if not existing:
                session.add(Broadcast(date=date_str, script="", is_ready=False))
                session.commit()

        print(f"[{date_str}] ニュース収集開始")
        news_items = await fetch_news()
        if not news_items:
            raise ValueError("ニュースを取得できませんでした")

        print(f"[{date_str}] {len(news_items)}件 → スクリプト生成")
        script = await generate_script(news_items, date_str, api_key=key)

        print(f"[{date_str}] 音声合成")
        audio_path = await synthesize(
            script, date_str,
            tts_provider=tts_provider,
            api_key=_resolve_openai_key(openai_key),
        )

        with get_session() as session:
            broadcast = session.query(Broadcast).filter_by(date=date_str).first()
            if not broadcast:
                broadcast = Broadcast(date=date_str)
                session.add(broadcast)
            broadcast.script = script
            broadcast.audio_path = audio_path
            broadcast.news_count = len(news_items)
            broadcast.is_ready = True
            session.commit()

            for item in news_items:
                session.add(NewsItem(
                    broadcast_date=date_str,
                    title=item.title,
                    summary=item.summary,
                    url=item.url,
                    source=item.source,
                    category=item.category,
                    published_at=item.published_at,
                ))
            session.commit()

        _generation_status[date_str] = "done"
        print(f"[{date_str}] 放送準備完了")

    except Exception as e:
        _generation_status[date_str] = "error"
        print(f"[{date_str}] エラー: {e}")
        raise


# ─── チャット（カスタムニュース） ─────────────────────────────────────────
async def run_chat_job(
    job_id: str,
    prompt: str,
    api_key: str,
    openai_key: str,
    tts_provider: str,
):
    try:
        news_items = await fetch_news()
        if not news_items:
            raise ValueError("ニュースを取得できませんでした")

        date_str = date.today().isoformat()
        script = await generate_script(
            news_items, date_str, api_key=api_key, custom_prompt=prompt,
        )
        stem = f"chat-{job_id}"
        audio_path = await synthesize(script, stem, tts_provider=tts_provider, api_key=openai_key)

        _chat_jobs[job_id] = {
            "status": "done",
            "audio_url": f"/audio/{stem}.mp3",
            "script": script,
        }
    except Exception as e:
        _chat_jobs[job_id] = {"status": "error", "error": str(e)}
        print(f"[chat:{job_id}] エラー: {e}")


# ─── エンドポイント ───────────────────────────────────────────────────────
@app.get("/")
async def index():
    return FileResponse(str(STATIC_DIR / "index.html"))


@app.get("/api/broadcasts")
async def list_broadcasts():
    with get_session() as session:
        rows = (
            session.query(Broadcast)
            .filter_by(is_ready=True)
            .order_by(Broadcast.date.desc())
            .limit(30)
            .all()
        )
        return [
            {
                "date": b.date,
                "news_count": b.news_count,
                "created_at": b.created_at.isoformat(),
                "has_audio": bool(b.audio_path and Path(b.audio_path).exists()),
            }
            for b in rows
        ]


@app.get("/api/broadcasts/{date_str}")
async def get_broadcast(date_str: str):
    with get_session() as session:
        broadcast = session.query(Broadcast).filter_by(date=date_str).first()
        if not broadcast or not broadcast.is_ready:
            raise HTTPException(status_code=404, detail="放送が見つかりません")

        news_items = session.query(NewsItem).filter_by(broadcast_date=date_str).all()
        audio_file = AUDIO_DIR / f"{date_str}.mp3"

        return {
            "date": broadcast.date,
            "script": broadcast.script,
            "news_count": broadcast.news_count,
            "audio_url": f"/audio/{date_str}.mp3" if audio_file.exists() else None,
            "created_at": broadcast.created_at.isoformat(),
            "news_items": [
                {"title": n.title, "summary": n.summary, "url": n.url,
                 "source": n.source, "category": n.category}
                for n in news_items
            ],
        }


@app.post("/api/generate")
async def trigger_generation(
    background_tasks: BackgroundTasks,
    target_date: str | None = None,
    x_api_key:      str | None = Header(default=None),
    x_openai_key:   str | None = Header(default=None),
    x_tts_provider: str | None = Header(default=None),
):
    date_str = target_date or date.today().isoformat()

    if _generation_status.get(date_str) == "running":
        return JSONResponse({"status": "running", "date": date_str})

    _generation_status[date_str] = "running"
    background_tasks.add_task(
        run_daily_broadcast, date_str,
        _resolve_key(x_api_key),
        _resolve_openai_key(x_openai_key),
        x_tts_provider,
    )
    return JSONResponse({"status": "started", "date": date_str})


@app.get("/api/status/{date_str}")
async def get_status(date_str: str):
    status = _generation_status.get(date_str, "unknown")
    with get_session() as session:
        broadcast = session.query(Broadcast).filter_by(date=date_str).first()
        if broadcast and broadcast.is_ready:
            status = "done"
    return {"date": date_str, "status": status}


class ChatRequest(BaseModel):
    prompt: str


@app.post("/api/chat")
async def chat_generate(
    req: ChatRequest,
    background_tasks: BackgroundTasks,
    x_api_key:      str | None = Header(default=None),
    x_openai_key:   str | None = Header(default=None),
    x_tts_provider: str | None = Header(default=None),
):
    job_id = uuid4().hex[:10]
    _chat_jobs[job_id] = {"status": "running"}
    background_tasks.add_task(
        run_chat_job,
        job_id,
        req.prompt,
        _resolve_key(x_api_key),
        _resolve_openai_key(x_openai_key),
        x_tts_provider or "gtts",
    )
    return {"job_id": job_id}


@app.get("/api/chat/{job_id}")
async def get_chat_job(job_id: str):
    job = _chat_jobs.get(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="ジョブが見つかりません")
    return job
